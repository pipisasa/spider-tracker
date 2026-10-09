import type { z } from "zod";
import { DomainError } from "./errors";

/** Parses input with a Zod schema, throwing a validation DomainError on failure. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new DomainError("validation", `${path}${issue?.message ?? "Invalid input"}`);
  }
  return parsed.data;
}
