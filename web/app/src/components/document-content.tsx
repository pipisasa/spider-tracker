import type { DocumentFormat } from "@repo/core/contracts";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a document. Markdown goes through react-markdown with raw HTML skipped.
 * HTML runs in a fully sandboxed iframe: no scripts, no same-origin access, no forms
 * or popups, so a document can't touch the app or the session (docs/decisions.md).
 */
export function DocumentContent({
  format,
  content,
}: {
  format: DocumentFormat;
  content: string;
}) {
  if (!content.trim())
    return (
      <p className="text-sm text-muted-foreground">This document is empty.</p>
    );
  if (format === "html") {
    return (
      <iframe
        title="Document"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={content}
        className="h-[70vh] w-full resize-y rounded-lg border bg-white"
      />
    );
  }
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert sm:prose-base">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml>
        {content}
      </Markdown>
    </div>
  );
}
