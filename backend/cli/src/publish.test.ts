import { afterAll, describe, expect, test } from "bun:test";
import type { DocumentDto } from "@repo/core/contracts";
import { SpiderApiError, type SpiderClient } from "@repo/sdk";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeUtf8,
  linkIndex,
  parseFrontMatter,
  parseSourceDoc,
  publishDocuments,
  publishLines,
  readSourceFolder,
  resolveLinks,
  setFrontMatter,
  type SourceDoc,
} from "./publish";

const A = "01a13118-ef01-7aa0-bf37-10e38fb20956";
const B = "01a13118-ef01-7aa0-bf37-10e38fb20957";

describe("front matter", () => {
  test("reads the known keys, unquoted, and the body without leading blank lines", () => {
    const raw = `---\ntitle: "Plan: v2"\nid: ${A}\nversion: 3\nproject: st\ntags: [x]\n---\n\n# Plan\n`;
    expect(parseFrontMatter(raw)).toEqual({
      fields: { title: "Plan: v2", id: A, version: "3", project: "st" },
      body: "# Plan\n",
    });
  });

  test("unquoted values lose a trailing # comment", () => {
    expect(parseFrontMatter("---\nproject: ST   # or task\ntitle: C# notes\nid: # none yet\n---\n").fields).toEqual({
      project: "ST",
      title: "C# notes",
    });
  });

  test("a file without front matter is all body; a --- later on isn't front matter", () => {
    expect(parseFrontMatter("# Plan\n---\nid: x\n---\n")).toEqual({ fields: {}, body: "# Plan\n---\nid: x\n---\n" });
    expect(parseFrontMatter("---\ntitle: T\n---")).toEqual({ fields: { title: "T" }, body: "" });
  });

  test("setFrontMatter replaces and adds keys, keeping the rest as written", () => {
    const raw = "---\ntitle: Plan\n# a comment\nversion: 1\n---\n\nBody\n";
    expect(setFrontMatter(raw, { id: A, version: "2" })).toBe(`---\ntitle: Plan\n# a comment\nversion: 2\nid: ${A}\n---\n\nBody\n`);
    expect(setFrontMatter("Body\n", { id: A, version: "1" })).toBe(`---\nid: ${A}\nversion: 1\n---\n\nBody\n`);
    expect(setFrontMatter("---\n---\nBody", { id: A })).toBe(`---\nid: ${A}\n---\nBody`);
    expect(setFrontMatter("---\r\ntitle: T\r\n---\r\nBody", { version: "4" })).toBe("---\r\ntitle: T\r\nversion: 4\r\n---\r\nBody");
    // Written back, the body reads the same.
    expect(parseFrontMatter(setFrontMatter("Body\n", { id: A })).body).toBe("Body\n");
  });

  test("a leading horizontal rule and paragraph aren't front matter: the whole file is the body", () => {
    expect(parseFrontMatter("---\n\nIntro\n\n---\n\nRest\n")).toEqual({ fields: {}, body: "---\n\nIntro\n\n---\n\nRest\n" });
    expect(parseFrontMatter("---\ntitle: T\nSome prose here\n---\nRest")).toEqual({ fields: {}, body: "---\ntitle: T\nSome prose here\n---\nRest" });
    // Written back, the rule stays part of the body, below a new block.
    const written = setFrontMatter("---\n\nIntro\n\n---\n\nRest\n", { id: A });
    expect(written).toBe(`---\nid: ${A}\n---\n\n---\n\nIntro\n\n---\n\nRest\n`);
    expect(parseFrontMatter(written)).toEqual({ fields: { id: A }, body: "---\n\nIntro\n\n---\n\nRest\n" });
  });

  test("comments, blank lines and nested YAML values still make front matter", () => {
    const raw = "---\n# notes\ntitle: T\n\ntags:\n  - a\n- b\nmeta:\n  x: 1\n---\nBody";
    expect(parseFrontMatter(raw)).toEqual({ fields: { title: "T" }, body: "Body" });
    // A nested line before any key isn't YAML front matter.
    expect(parseFrontMatter("---\n  indented\n---\nBody").fields).toEqual({});
  });

  test("a leading BOM is ignored when reading and kept, once, when writing back", () => {
    const raw = `\uFEFF---\ntitle: T\n---\n\nBody\n`;
    expect(parseFrontMatter(raw)).toEqual({ fields: { title: "T" }, body: "Body\n" });
    expect(parseSourceDoc("a.md", raw)).toMatchObject({ title: "T", body: "Body\n" });
    expect(setFrontMatter(raw, { id: A })).toBe(`\uFEFF---\ntitle: T\nid: ${A}\n---\n\nBody\n`);
    expect(setFrontMatter("\uFEFFBody", { id: A })).toBe(`\uFEFF---\nid: ${A}\n---\n\nBody`);
    expect(parseFrontMatter("\uFEFFBody").body).toBe("Body");
  });

  test("decodeUtf8: strict, keeping a BOM; other encodings are null", () => {
    expect(decodeUtf8(new TextEncoder().encode("Привет"))).toBe("Привет");
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe("\uFEFFA");
    // "Привет" in cp1251.
    expect(decodeUtf8(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).toBeNull();
  });

  test("parseSourceDoc: title from the file name, keys upper-cased, bad id or version rejected", () => {
    const doc = parseSourceDoc("specs/Data model.md", "---\ntask: st-12\n---\nText");
    expect(doc).toMatchObject({ path: "specs/Data model.md", title: "Data model", task: "ST-12", project: null, id: null, version: null, body: "Text" });
    expect(() => parseSourceDoc("a.md", "---\nid: D31\n---\n")).toThrow('a.md: id "D31" isn\'t a document id');
    expect(() => parseSourceDoc("a.md", `---\nid: ${A}\nversion: 0\n---\n`)).toThrow("isn't a positive integer");
  });
});

describe("resolveLinks", () => {
  const plan = parseSourceDoc("plan.md", `---\nid: ${A}\n---\n`);
  const model = parseSourceDoc("specs/model.md", "---\ntitle: Data model\n---\n");
  const docs = [plan, model];
  const index = linkIndex(docs);
  const ids = new Map<SourceDoc, string>([[plan, A], [model, B]]);
  const resolve = (path: string, body: string, idOf = (d: SourceDoc) => ids.get(d) ?? null) =>
    resolveLinks({ ...parseSourceDoc(path, body) }, index, idOf);

  test("[[Title]] and [[file name]] links to files of the folder become [[doc:<id>]], keeping #heading and |label", () => {
    expect(resolve("x.md", "See [[Data model]], [[data  MODEL#Tables|tables]] and [[plan]].").content).toBe(
      `See [[doc:${B}]], [[doc:${B}#Tables|tables]] and [[doc:${A}]].`,
    );
  });

  test("relative .md links resolve from the file's folder, the text as the label", () => {
    expect(resolve("specs/x.md", "[the plan](../plan.md#Goals) and [](model.md) and [m](<./model.md>)").content).toBe(
      `[[doc:${A}#Goals|the plan]] and [[doc:${B}]] and [[doc:${B}|m]]`,
    );
  });

  test("leaves code, tasks, ids, URLs, images and titles outside the folder as written", () => {
    const body = [
      "`[[plan]]` and",
      "```\n[x](plan.md)\n```",
      "[[ST-12]] [[doc:" + B + "]] [[Elsewhere]]",
      "[site](https://example.com/plan.md) ![img](plan.md) [top](#plan)",
    ].join("\n");
    const resolved = resolve("x.md", body);
    expect(resolved.content).toBe(body);
    expect(resolved.warnings).toEqual([]);
  });

  test("warns about .md links outside the folder and ambiguous titles", () => {
    const twin = parseSourceDoc("other/plan.md", "");
    const both = linkIndex([plan, twin]);
    const resolved = resolveLinks(parseSourceDoc("x.md", "[[plan]] [gone](missing.md)"), both, () => A);
    expect(resolved.content).toBe(`[[doc:${A}]] [gone](missing.md)`);
    expect(resolved.warnings).toEqual([
      "[[plan]] matches plan.md, other/plan.md; linked to plan.md",
      "missing.md isn't a file of the folder; left as written",
    ]);
  });

  test("links to files without a document yet stay as written and are listed as pending", () => {
    const resolved = resolve("x.md", "[[Data model]] and [p](plan.md)", (d) => (d === plan ? A : null));
    expect(resolved.content).toBe(`[[Data model]] and [[doc:${A}|p]]`);
    expect(resolved.pending).toEqual(["specs/model.md"]);
  });
});

test("publishLines: one line per file, messages and warnings, then the counts", () => {
  const text = publishLines({
    dryRun: true,
    results: [
      { file: "a.md", status: "created", id: null, title: "A", version: null },
      { file: "bb.md", status: "conflict", id: A, title: "B", version: 4, message: "Changed", warnings: ["w"] },
    ],
    warnings: ["link.md is a symbolic link; skipped"],
    summary: { created: 1, updated: 0, unchanged: 0, conflict: 1, failed: 0 },
  });
  expect(text).toBe(
    [
      "warning: link.md is a symbolic link; skipped",
      "would create  a.md   A",
      `conflict      bb.md  B  (${A}, v4)`,
      "  Changed",
      "  warning: w",
      "Dry run: 1 to create, 0 to update, 0 unchanged, 1 conflict, 0 failed; nothing was changed.",
    ].join("\n"),
  );
});

describe("readSourceFolder", () => {
  const base = mkdtempSync(join(tmpdir(), "spider-publish-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("skips symbolic links and paths outside the folder; files too large or not UTF-8 fail", async () => {
    const root = join(base, "docs");
    const outside = join(base, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "outside");
    writeFileSync(join(root, "ok.md"), "\uFEFF---\ntitle: OK\n---\nHi");
    writeFileSync(join(root, "sub", "cp1251.md"), new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
    writeFileSync(join(root, "big.md"), "x".repeat(1_000_001));
    symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
    symlinkSync(outside, join(root, "away"));
    const folder = await readSourceFolder(root);
    expect(folder.docs.map((d) => [d.path, d.title, d.body])).toEqual([["ok.md", "OK", "Hi"]]);
    expect(folder.docs[0]?.raw.startsWith("\uFEFF")).toBe(true);
    expect(folder.failed.map((f) => [f.file, f.status, f.message?.split(";")[0]])).toEqual([
      ["big.md", "failed", "1001 KB is more than a document can hold (1 MB)"],
      ["sub/cp1251.md", "failed", "Not UTF-8 text"],
    ]);
    expect(folder.warnings).toContain("link.md is a symbolic link; skipped");
    // A linked folder is either not listed or its files are skipped as outside.
    expect(folder.warnings.filter((w) => w.startsWith("away/")).every((w) => w.includes("outside the folder"))).toBe(true);
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("outside");
  });
});

describe("publishDocuments", () => {
  const C = "01a13118-ef01-7aa0-bf37-10e38fb20958";
  const dto = (id: string, version: number, title: string, content: string): DocumentDto =>
    ({ id, version, title, content, format: "md", url: `https://x/${id}` }) as DocumentDto;
  const fakeClient = (handlers: {
    get?: (id: string) => Promise<DocumentDto>;
    create?: (input: { title: string; content: string }) => Promise<DocumentDto>;
    update?: (id: string, input: { content: string }) => Promise<DocumentDto>;
  }) =>
    ({
      documents: {
        get: (_org: string, id: string) => (handlers.get ?? (() => Promise.reject(new Error("get"))))(id),
        create: (_org: string, input: { title: string; content: string }) => (handlers.create ?? (() => Promise.reject(new Error("create"))))(input),
        update: (_org: string, id: string, input: { content: string }) => (handlers.update ?? (() => Promise.reject(new Error("update"))))(id, input),
      },
    }) as unknown as SpiderClient;

  test("a document created whose file can't be written is reported created, with its id", async () => {
    const doc = parseSourceDoc("a.md", "Text");
    const response = await publishDocuments({
      client: fakeClient({ create: async (input) => dto(A, 1, input.title, input.content) }),
      org: "o",
      docs: [doc],
      dryRun: false,
      save: () => Promise.reject(new Error("EACCES: permission denied")),
    });
    expect(response.results[0]).toMatchObject({ file: "a.md", status: "created", id: A, version: 1 });
    expect(response.results[0]?.message).toContain(`add "id: ${A}" and "version: 1" to its front matter`);
    expect(response.summary.created).toBe(1);
  });

  test("links to a file whose document is gone stay as written, with a warning", async () => {
    const gone = parseSourceDoc("gone.md", `---\nid: ${B}\nversion: 1\n---\nOld`);
    const linking = parseSourceDoc("x.md", `---\nid: ${A}\nversion: 1\n---\nSee [[gone]] and [g](gone.md).`);
    const fresh = parseSourceDoc("new.md", "Also [[gone]].");
    const saved: string[] = [];
    const response = await publishDocuments({
      client: fakeClient({
        get: async (id) => {
          if (id === B) throw new SpiderApiError(404, "not_found", "Not found");
          return dto(A, 1, "x", "before");
        },
        create: async (input) => {
          saved.push(input.content);
          return dto(C, 1, input.title, input.content);
        },
        update: async (id, input) => {
          saved.push(input.content);
          return dto(id, 2, "x", input.content);
        },
      }),
      org: "o",
      docs: [gone, linking, fresh],
      failed: [{ file: "bad.md", status: "failed", id: null, title: "bad", version: null, message: "Not UTF-8 text" }],
      dryRun: false,
      save: async () => {},
    });
    // Created once (no second save waiting for the gone document), updated with the links as written.
    expect(saved).toEqual(["Also [[gone]].", "See [[gone]] and [g](gone.md)."]);
    expect(response.results.map((r) => [r.file, r.status])).toEqual([
      ["bad.md", "failed"],
      ["gone.md", "failed"],
      ["new.md", "created"],
      ["x.md", "updated"],
    ]);
    expect(response.results.find((r) => r.file === "x.md")?.warnings).toEqual(["links to gone.md stay as written: it has no document"]);
    expect(response.summary).toEqual({ created: 1, updated: 1, unchanged: 0, conflict: 0, failed: 2 });
  });

  test("reads at most 8 documents at a time", async () => {
    const docs = Array.from({ length: 20 }, (_, i) =>
      parseSourceDoc(`d${String(i).padStart(2, "0")}.md`, `---\nid: 01a13118-ef01-7aa0-bf37-10e38fb209${String(i).padStart(2, "0")}\nversion: 1\n---\nT`),
    );
    let active = 0;
    let peak = 0;
    const response = await publishDocuments({
      client: fakeClient({
        get: async (id) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 2));
          active -= 1;
          return dto(id, 1, docs.find((d) => d.id === id)?.title ?? "", "T");
        },
      }),
      org: "o",
      docs,
      dryRun: false,
      save: async () => {},
    });
    expect(response.summary.unchanged).toBe(20);
    expect(peak).toBe(8);
  });
});
