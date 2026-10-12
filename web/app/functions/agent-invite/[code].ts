import { marked } from "marked";
import {
  formatInviteCode,
  inviteInstructions,
  inviteLink,
} from "../../src/lib/agent-invite-instructions";

// Server-rendered invite page (ST-34): the SPA route is empty to fetchers that don't run
// JavaScript, such as Claude Code's WebFetch. It only checks the code's shape and never calls
// the API, so it can't be used to test whether a code is valid, and it never redeems it.

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

const STYLE = `
:root { color-scheme: light dark; --fg: #1c1c1e; --muted: #6b6b70; --bg: #fff; --code: #f3f3f5; --border: #e2e2e6; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf0; --muted: #a0a0a8; --bg: #141416; --code: #1f1f23; --border: #2e2e33; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
h1 { font-size: 1.6rem; line-height: 1.3; }
h2 { font-size: 1.2rem; margin-top: 2rem; }
code { font: 0.875em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: var(--code); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; overflow-x: auto; }
pre code { background: none; padding: 0; }
li { margin: 0.5rem 0; }
footer { margin-top: 3rem; color: var(--muted); font-size: 0.875rem; }
a { color: inherit; }
`;

const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function page(title: string, body: string, head = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${head}<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function wantsMarkdown(request: Request) {
  const accept = request.headers.get("Accept") ?? "";
  const quality = (type: string) => {
    const entry = accept
      .split(",")
      .find((part) => part.trim().startsWith(type));
    if (!entry) return -1;
    const q = /;\s*q=([\d.]+)/.exec(entry);
    return q ? Number(q[1]) : 1;
  };
  return (
    Math.max(quality("text/markdown"), quality("text/plain")) >
    quality("text/html")
  );
}

export const onRequestGet: PagesFunction<Record<string, never>, "code"> = ({
  request,
  params,
}) => {
  const raw = typeof params.code === "string" ? params.code : "";
  const asMarkdownFile = raw.toLowerCase().endsWith(".md");
  const code = formatInviteCode(asMarkdownFile ? raw.slice(0, -3) : raw);

  if (!code) {
    return new Response(
      page(
        "Invite not found",
        "<h1>Invite not found</h1><p>This doesn't look like an agent invite link.</p>",
      ),
      {
        status: 404,
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  }

  const origin = new URL(request.url).origin;
  const link = inviteLink(origin, code);
  const markdown = inviteInstructions({ code, link, origin });

  if (asMarkdownFile || wantsMarkdown(request)) {
    return new Response(markdown, {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "text/markdown; charset=utf-8",
        Vary: "Accept",
      },
    });
  }

  const html = marked.parse(markdown, { async: false });
  const alternate = `<link rel="alternate" type="text/markdown" href="${escapeHtml(`${link}.md`)}">\n`;
  return new Response(
    page(
      `Spider Tracker agent invite ${code}`,
      `${html}<footer>Also available as <a href="${escapeHtml(`${link}.md`)}">Markdown</a>.</footer>`,
      alternate,
    ),
    {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        Vary: "Accept",
      },
    },
  );
};

export const onRequestHead = onRequestGet;
