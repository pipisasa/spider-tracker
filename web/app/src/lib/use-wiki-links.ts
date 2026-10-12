import type { WikiLinkHost } from "@/components/editor/wiki-link";
import { documentsQuery, useCreateDocument } from "@/lib/work";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";
import { wikiDestination, wikiSuggestions } from "./wiki-links";

/**
 * Resolves, opens and suggests `[[links]]` written in a document (ST-100). Opening a title no
 * document has creates it in the same place, as Obsidian does, when the viewer can write.
 */
export function useWikiLinks({
  orgSlug,
  from,
  canWrite,
}: {
  orgSlug: string;
  /** The document holding the links. */
  from: { id: string; projectKey: string | null };
  canWrite: boolean;
}): WikiLinkHost {
  const { data: documents = [] } = useQuery(documentsQuery(orgSlug));
  const navigate = useNavigate();
  // `mutate` is stable; the mutation object isn't.
  const createDocument = useCreateDocument(orgSlug).mutate;

  return useMemo<WikiLinkHost>(() => {
    const destination = (target: string) =>
      wikiDestination(documents, target, from.projectKey);
    return {
      href: (target) => {
        const to = destination(target);
        if (to.type === "document") return `/${orgSlug}/docs/${to.id}`;
        if (to.type === "task") return `/${orgSlug}/tasks/${to.key}`;
        return null;
      },
      open: (target) => {
        const to = destination(target);
        if (to.type === "document") {
          void navigate({
            to: "/$orgSlug/docs/$documentId",
            params: { orgSlug, documentId: to.id },
          });
        } else if (to.type === "task") {
          void navigate({
            to: "/$orgSlug/tasks/$taskKey",
            params: { orgSlug, taskKey: to.key },
          });
        } else if (!canWrite) {
          toast.info(`No document is titled “${to.title}” yet`);
        } else {
          createDocument(
            { title: to.title, ...(from.projectKey ? { project: from.projectKey } : {}) },
            {
              onSuccess: (doc) =>
                void navigate({
                  to: "/$orgSlug/docs/$documentId",
                  params: { orgSlug, documentId: doc.id },
                  search: { edit: true },
                }),
              onError: (err) => toast.error(err.message),
            },
          );
        }
      },
      suggest: (query) =>
        wikiSuggestions(documents, query, {
          fromProjectKey: from.projectKey,
          excludeId: from.id,
        }),
    };
  }, [documents, from.id, from.projectKey, orgSlug, navigate, canWrite, createDocument]);
}
