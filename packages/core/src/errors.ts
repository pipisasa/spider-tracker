export type DomainErrorCode =
  "validation" | "not_found" | "conflict" | "forbidden" | "rate_limited";

export class DomainError extends Error {
  /** What the error is about, when it has an address (the open pull request of a 409); sent as `error.url`. */
  readonly url?: string;

  constructor(
    readonly code: DomainErrorCode,
    message: string,
    options?: { url?: string },
  ) {
    super(message);
    this.name = "DomainError";
    if (options?.url !== undefined) this.url = options.url;
  }
}

/** Whether `err` (as thrown by drizzle over postgres-js) is a unique violation, optionally of the named constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (
    let e: unknown = err, depth = 0;
    e instanceof Error && depth < 3;
    e = e.cause, depth++
  ) {
    const { code, constraint_name } = e as Error & {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (code === "23505")
      return constraint === undefined || constraint_name === constraint;
  }
  return false;
}

/** Whether `err` is Postgres aborting the transaction over a deadlock (40P01) or a serialization failure (40001). */
export function isLockConflict(err: unknown): boolean {
  for (
    let e: unknown = err, depth = 0;
    e instanceof Error && depth < 3;
    e = e.cause, depth++
  ) {
    const { code } = e as Error & { code?: unknown };
    if (code === "40P01" || code === "40001") return true;
  }
  return false;
}
