import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentBody } from "./comment-body";

const html = (body: string) =>
  renderToStaticMarkup(
    <CommentBody body={body} handles={new Set(["alice", "dev-bot"])} />,
  );

test("renders Markdown with mentions, chat-style line breaks and safe links", () => {
  const out = html(
    "**Done** in `abc @alice` see [PR](https://x.test)\nthanks @alice and @bob and @Dev-Bot\n\n- one\n- two\n\n```\n@alice\n```\n<script>alert(1)</script>",
  );
  expect(out).toContain("<strong>Done</strong>");
  expect(out).toContain("<code>abc @alice</code>");
  expect(out).toContain(
    '<a href="https://x.test" target="_blank" rel="noopener noreferrer">PR</a>',
  );
  expect(out).toContain(
    '<br/>\nthanks <span class="mention">@alice</span> and @bob and <span class="mention">@Dev-Bot</span>',
  );
  expect(out).toContain("<li>one</li>");
  expect(out).toContain("<pre><code>@alice\n</code></pre>");
  expect(out).not.toContain("<script>");
});
