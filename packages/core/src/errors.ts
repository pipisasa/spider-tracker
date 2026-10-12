export type DomainErrorCode = "validation" | "not_found" | "conflict" | "forbidden" | "rate_limited";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Whether `err` (as thrown by drizzle over postgres-js) is a unique violation, optionally of the named constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    const { code, constraint_name } = e as Error & { code?: unknown; constraint_name?: unknown };
    if (code === "23505") return constraint === undefined || constraint_name === constraint;
  }
  return false;
}
