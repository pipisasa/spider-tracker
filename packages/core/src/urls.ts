// Web addresses of tasks, projects and documents (ST-115). Browser-safe: the API puts them in
// its responses (the `url` field), and they follow the web app's routes
// (web/app/src/routes/_authed/$orgSlug/…).

/** Builds the web pages' addresses for one organization. */
export interface WebUrls {
  project(key: string): string;
  task(key: string): string;
  document(id: string): string;
}

/** `webOrigin` is the web app's origin (e.g. https://tracker.example.com); a trailing slash is ignored. */
export function webUrls(webOrigin: string, orgSlug: string): WebUrls {
  const base = `${webOrigin.replace(/\/+$/, "")}/${encodeURIComponent(orgSlug)}`;
  return {
    project: (key) => `${base}/projects/${encodeURIComponent(key)}`,
    task: (key) => `${base}/tasks/${encodeURIComponent(key)}`,
    document: (id) => `${base}/docs/${encodeURIComponent(id)}`,
  };
}

/** The same value with its web page's address. */
export type WithUrl<T> = T & { url: string };

export const withProjectUrl = <T extends { key: string }>(urls: WebUrls, project: T): WithUrl<T> => ({
  ...project,
  url: urls.project(project.key),
});

export const withTaskUrl = <T extends { key: string }>(urls: WebUrls, task: T): WithUrl<T> => ({
  ...task,
  url: urls.task(task.key),
});

export const withDocumentUrl = <T extends { id: string }>(urls: WebUrls, document: T): WithUrl<T> => ({
  ...document,
  url: urls.document(document.id),
});
