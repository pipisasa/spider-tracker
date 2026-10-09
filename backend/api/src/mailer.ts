export interface Mailer {
  sendMagicLink(email: string, url: string): Promise<void>;
}

/** Development mailer: prints links to the console instead of sending email. */
export const consoleMailer: Mailer = {
  async sendMagicLink(email, url) {
    console.info(`[mail] magic link for ${email}: ${url}`);
  },
};
