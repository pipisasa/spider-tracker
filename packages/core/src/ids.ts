const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a UUID. Ids from URLs are checked first: a malformed one would reach Postgres as an invalid uuid (500). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
