import { expect, test } from "bun:test";
import { webUrls, withDocumentUrl, withProjectUrl, withTaskUrl } from "./urls";

test("webUrls follow the web app's routes (ST-115)", () => {
  const urls = webUrls("https://tracker.example.com/", "batele");
  expect(urls.project("ST")).toBe("https://tracker.example.com/batele/projects/ST");
  expect(urls.task("ST-12")).toBe("https://tracker.example.com/batele/tasks/ST-12");
  expect(urls.document("abc")).toBe("https://tracker.example.com/batele/docs/abc");
  expect(withTaskUrl(urls, { key: "ST-1", title: "T" })).toEqual({
    key: "ST-1",
    title: "T",
    url: "https://tracker.example.com/batele/tasks/ST-1",
  });
  expect(withProjectUrl(urls, { key: "ST" }).url).toBe(urls.project("ST"));
  expect(withDocumentUrl(urls, { id: "d" }).url).toBe(urls.document("d"));
});
