import type { Env } from "./env";

export interface Mailer {
  sendMagicLink(email: string, url: string): Promise<void>;
}

/** Development mailer: prints links to the console instead of sending email. */
export const consoleMailer: Mailer = {
  async sendMagicLink(email, url) {
    console.info(`[mail] magic link for ${email}: ${url}`);
  },
};

const RESEND_API = "https://api.resend.com/emails";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

/** The sign-in email: plain text plus a minimal HTML version with one button. */
export function magicLinkEmail(url: string) {
  const subject = "Sign in to Spider Tracker";
  const text = `Open this link to sign in to Spider Tracker:\n\n${url}\n\nIt expires in 5 minutes and works once. If you didn't ask for it, ignore this email.\n`;
  const href = escapeHtml(url);
  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; line-height: 1.5">
    <p>Click the button to sign in to Spider Tracker.</p>
    <p><a href="${href}" style="display: inline-block; padding: 10px 18px; background: #111; color: #fff; border-radius: 6px; text-decoration: none">Sign in</a></p>
    <p style="color: #666; font-size: 13px">Or paste this link into your browser:<br />${href}</p>
    <p style="color: #666; font-size: 13px">It expires in 5 minutes and works once. If you didn't ask for it, ignore this email.</p>
  </body>
</html>
`;
  return { subject, text, html };
}

/** Sends email through Resend's HTTP API (ST-18). Throws when Resend refuses the message. */
export function createResendMailer({
  apiKey,
  from,
  fetch: fetchImpl = fetch,
}: {
  apiKey: string;
  from: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): Mailer {
  return {
    async sendMagicLink(email, url) {
      const res = await fetchImpl(RESEND_API, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [email], ...magicLinkEmail(url) }),
      });
      if (!res.ok) {
        // Resend errors are { name, message, statusCode }; never include the key or the link.
        const detail = await res.text().catch(() => "");
        throw new Error(`Resend refused the email (${res.status}): ${detail.slice(0, 300)}`);
      }
    },
  };
}

/** Resend when RESEND_API_KEY is set, otherwise the console mailer. */
export function createMailer(env: Env): Mailer {
  if (env.RESEND_API_KEY) return createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
  if (env.NODE_ENV === "production") {
    console.warn("[mail] RESEND_API_KEY is not set: magic links are only logged, not emailed");
  }
  return consoleMailer;
}
