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

/** A new account needs an address on the list that the sign-in method has proven (ST-17). Empty list = open. */
export function isSignupAllowed(user: { email: string; emailVerified: boolean }, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return user.emailVerified && isEmailAllowed(user.email, allowlist);
}

/**
 * Magic links go to existing users and to addresses that could sign up; anything else could only
 * end in a refused sign-up (ST-17). Callers look the user up on every path so timing stays equal (ST-56).
 */
export function mayReceiveMagicLink({
  email,
  allowlist,
  userExists,
}: {
  email: string;
  allowlist: string[];
  userExists: boolean;
}): boolean {
  return userExists || isEmailAllowed(email, allowlist);
}
