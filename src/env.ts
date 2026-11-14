// ---------------------------------------------------------------------------
// Environment reader.
//
// Every setting is required: there are no defaults. The reader collects every
// missing or invalid variable from core and from the backend module, so that
// startup fails once with the complete list.
//
// Any variable NAME can instead be given as NAME_FILE, the path of a file that
// holds the value (Docker / Kubernetes secrets). One trailing newline is
// stripped. Setting both NAME and NAME_FILE is an error.
// ---------------------------------------------------------------------------

import fs from 'fs';

export class EnvError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      `Invalid configuration — ${problems.length} problem(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'EnvError';
  }
}

export class Env {
  private readonly problems: string[] = [];

  constructor(
    private readonly source: Record<string, string | undefined>,
    private readonly readFile: (path: string) => string = (path) => fs.readFileSync(path, 'utf8'),
  ) {}

  /** A non-empty string, from NAME or from the file named by NAME_FILE. */
  require(name: string, description: string): string {
    const direct = this.source[name];
    const hasDirect = direct !== undefined && direct.trim() !== '';
    const filePath = this.source[`${name}_FILE`];

    if (filePath === undefined || filePath.trim() === '') {
      if (!hasDirect) {
        this.problems.push(`${name} is not set. ${description}`);
        return '';
      }
      return direct as string;
    }

    if (hasDirect) {
      this.problems.push(`${name} and ${name}_FILE are both set; set only one. ${description}`);
      return '';
    }

    let value: string;
    try {
      value = this.readFile(filePath).replace(/\r?\n$/, '');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.problems.push(`${name}_FILE='${filePath}' could not be read: ${reason}. ${description}`);
      return '';
    }
    if (value.trim() === '') {
      this.problems.push(`${name}_FILE='${filePath}' is empty. ${description}`);
      return '';
    }
    return value;
  }

  /** An integer within [min, max]. */
  requireInt(name: string, description: string, min: number, max: number): number {
    const raw = this.require(name, description);
    if (raw === '') return min;
    if (!/^-?\d+$/.test(raw.trim()) || Number(raw) < min || Number(raw) > max) {
      this.problems.push(
        `${name}='${raw}' is not valid: expected an integer from ${min} to ${max}. ${description}`,
      );
      return min;
    }
    return Number(raw);
  }

  /** One of a fixed set of values. */
  requireEnum<T extends string>(name: string, description: string, allowed: readonly T[]): T {
    const raw = this.require(name, description);
    if (raw === '') return allowed[0];
    if (!(allowed as readonly string[]).includes(raw)) {
      this.problems.push(
        `${name}='${raw}' is not valid: expected one of ${allowed.join(' | ')}. ${description}`,
      );
      return allowed[0];
    }
    return raw as T;
  }

  /** `true` or `false`. */
  requireBoolean(name: string, description: string): boolean {
    // 'false' first: a missing value reads as false, so it cannot trigger
    // follow-on "required when true" problems that would clutter the report
    return this.requireEnum(name, description, ['false', 'true'] as const) === 'true';
  }

  /** A non-empty comma-separated list. */
  requireList(name: string, description: string): string[] {
    const items = this.require(name, description)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return items;
  }

  /** Report a problem found by a cross-field check. */
  fail(problem: string): void {
    this.problems.push(problem);
  }

  /** Throw {@link EnvError} if any variable was missing or invalid. */
  assertValid(): void {
    if (this.problems.length > 0) throw new EnvError(this.problems);
  }
}
