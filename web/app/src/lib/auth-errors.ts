// Readable messages for Better Auth's redirect error codes (`?error=<code>`).
const messages: Record<string, string> = {
  account_not_linked:
    "An account with this email already exists. Sign in with an email link, then link this sign-in method from your account.",
  account_already_linked_to_different_user: "That account is already linked to a different Spider Tracker user.",
  "email_doesn't_match": "That account uses a different email than yours, so it can't be linked.",
  access_denied: "Sign-in was cancelled.",
  state_not_found: "That sign-in attempt expired. Please try again.",
};

export function authErrorMessage(code: string): string {
  return messages[code] ?? `Sign-in failed (${code.replaceAll("_", " ")}).`;
}
