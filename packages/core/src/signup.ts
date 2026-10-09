// Who may create an account (ST-17). Existing users can always sign in.

/** Parses SIGNUP_ALLOWLIST: comma/space separated emails and "@domain" entries. Empty means open. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const address = email.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf("@"));
  return allowlist.some((entry) => (entry.startsWith("@") ? domain === entry : address === entry));
}
