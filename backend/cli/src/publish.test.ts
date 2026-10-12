import { describe, expect, test } from "bun:test";
import { linkIndex, parseFrontMatter, parseSourceDoc, publishLines, resolveLinks, setFrontMatter, type SourceDoc } from "./publish";

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
    summary: { created: 1, updated: 0, unchanged: 0, conflict: 1, failed: 0 },
  });
  expect(text).toBe(
    [
      "would create  a.md   A",
      `conflict      bb.md  B  (${A}, v4)`,
      "  Changed",
      "  warning: w",
      "Dry run: 1 to create, 0 to update, 0 unchanged, 1 conflict, 0 failed; nothing was changed.",
    ].join("\n"),
  );
});
