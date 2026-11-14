// ---------------------------------------------------------------------------
// Environment reader.
//
// Every setting is required: there are no defaults. The reader collects every
// missing or invalid variable from core and from the backend module, so that
// startup fails once with the complete list.
// ---------------------------------------------------------------------------

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

  constructor(private readonly source: Record<string, string | undefined>) {}

  /** A non-empty string. */
  require(name: string, description: string): string {
    const value = this.source[name];
    if (value === undefined || value.trim() === '') {
      this.problems.push(`${name} is not set. ${description}`);
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
