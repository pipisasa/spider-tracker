import { describe, expect, test } from "bun:test";
import type { ReleaseChangelogDto } from "./contracts";
import {
  appNotes,
  changelogBlock,
  changelogFileSection,
  changelogState,
  compareVersions,
  escapeMarkers,
  findHandoff,
  flattenHeadings,
  finishChangelog,
  insertReleaseSection,
  previousTag,
  regroupChangelog,
  releaseTag,
  renderChangelog,
  versionOfTag,
  whatChangedIn,
  withChangelog,
} from "./release-notes";

describe("whatChangedIn", () => {
  test("a bold label section ends at the next bold label", () => {
    const body = [
      "**Handoff (ST-93):** branch `st-93`, commits `e3dbe90`.",
      "",
      "**What changed**",
      "- **Model:** a release is a task.",
      "  - nested detail",
      "- **CLI:** `spider release`.",
      "",
      "**Verified**",
      "- Tests pass.",
    ].join("\n");
    expect(whatChangedIn(body)).toBe(
      "- **Model:** a release is a task.\n  - nested detail\n- **CLI:** `spider release`.",
    );
  });

  test("headings, a colon inside or after the label, text on the label line, plain labels", () => {
    expect(
      whatChangedIn(
        "## What changed\nAdded X.\n\n## How it was verified\nTests.",
      ),
    ).toBe("Added X.");
    expect(whatChangedIn("### What changed:\n- a\n### Open\n- b")).toBe("- a");
    expect(
      whatChangedIn(
        "**What changed:** Fixed the board.\nMore.\n**Open:** none",
      ),
    ).toBe("Fixed the board.\nMore.");
    expect(whatChangedIn("**What changed**: one line")).toBe("one line");
    expect(whatChangedIn("What changed:\n- a\n- b\n\nVerified:\n- c")).toBe(
      "- a\n- b",
    );
    expect(whatChangedIn("what changed: inline only")).toBe("inline only");
  });

  test("prose with a colon doesn't end the section; a code fence can hold labels", () => {
    expect(
      whatChangedIn(
        "**What changed**\nNote: this stays.\n```\n**Not a label**\n```\n**Open**\nx",
      ),
    ).toBe("Note: this stays.\n```\n**Not a label**\n```");
  });

  test("none, or an empty section", () => {
    expect(whatChangedIn("Looks good, approved.")).toBeNull();
    expect(whatChangedIn("**What changed**\n\n**Verified**\nok")).toBeNull();
  });
});

describe("findHandoff", () => {
  const c = (
    id: string,
    authorId: string,
    body: string,
    createdAt: string,
  ) => ({ id, authorId, body, createdAt });
  test("the latest comment with a section by an assignee, else by anyone", () => {
    const comments = [
      c("1", "dev", "**What changed**\n- old", "2026-10-01T00:00:00Z"),
      c("2", "dev", "**What changed**\n- new", "2026-10-02T00:00:00Z"),
      c(
        "3",
        "reviewer",
        "**What changed**\n- reviewer summary",
        "2026-10-03T00:00:00Z",
      ),
      c("4", "dev", "Thanks!", "2026-10-04T00:00:00Z"),
    ];
    expect(findHandoff(comments, ["dev"])).toMatchObject({
      comment: { id: "2" },
      whatChanged: "- new",
    });
    expect(findHandoff(comments, ["someone-else"])).toMatchObject({
      comment: { id: "3" },
    });
    expect(
      findHandoff(
        [c("5", "dev", "no section", "2026-10-05T00:00:00Z")],
        ["dev"],
      ),
    ).toBeNull();
  });
});

describe("tags and versions", () => {
  const web = { name: "web", versioning: "date" as const };
  const cli = { name: "cli", versioning: "semver" as const };
  test("tags per app", () => {
    expect(releaseTag(web, "2026.10.12")).toBe("web-2026.10.12");
    expect(releaseTag(cli, "0.1.7")).toBe("cli-v0.1.7");
    expect(versionOfTag(cli, "cli-v0.1.7")).toBe("0.1.7");
    expect(versionOfTag(cli, "cli-0.1.7")).toBeNull();
    expect(versionOfTag(web, "web-2026.10.12")).toBe("2026.10.12");
    expect(versionOfTag(web, "webapp-2026.10.12")).toBeNull();
  });

  test("ordering and the previous tag", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("2026.10.2", "2026.9.30")).toBeGreaterThan(0);
    const tags = [
      "cli-v0.1.8",
      "cli-v0.1.10",
      "cli-v0.1.9",
      "web-2026.10.01",
      "unrelated",
    ];
    expect(previousTag(cli, tags, "0.1.10")).toBe("cli-v0.1.9");
    expect(previousTag(cli, tags, "0.2.0")).toBe("cli-v0.1.10");
    expect(previousTag(cli, tags, null)).toBe("cli-v0.1.10");
    expect(previousTag(cli, tags, "0.1.8")).toBeNull();
    expect(previousTag(web, tags, "2026.10.13")).toBe("web-2026.10.01");
  });
});

describe("renderChangelog", () => {
  const apps = [
    { name: "web", version: "2026.10.13" },
    { name: "cli", version: "0.1.9" },
  ];
  const entries = [
    {
      key: "ST-1",
      title: "Board",
      whatChanged: "- Columns\n## Details\n- More",
      apps: ["web"],
    },
    { key: "ST-2", title: "Shared", whatChanged: null, apps: ["cli", "web"] },
    { key: "OPS-3", title: "Runbook", whatChanged: "Wrote it.", apps: [] },
  ];
  test("grouped: a section per app, a task in each app it touches, other changes last; headings in notes flattened", () => {
    expect(renderChangelog(apps, entries, true)).toBe(
      [
        "### web 2026.10.13",
        "",
        "- **ST-1** Board",
        "  - Columns",
        "  **Details**",
        "  - More",
        "- **ST-2** Shared",
        "",
        "### cli 0.1.9",
        "",
        "- **ST-2** Shared",
        "",
        "### Other changes",
        "",
        "- **OPS-3** Runbook",
        "  Wrote it.",
      ].join("\n"),
    );
  });

  test("not grouped, no apps, no tasks, an app without tasks", () => {
    expect(
      renderChangelog(apps, entries, false).startsWith(
        "### Changes\n\n- **ST-1** Board",
      ),
    ).toBe(true);
    expect(renderChangelog([], entries.slice(2), false)).toBe(
      "- **OPS-3** Runbook\n  Wrote it.",
    );
    expect(renderChangelog(apps, [], true)).toBe(
      "_No tasks in this release yet._",
    );
    expect(renderChangelog(apps, entries.slice(0, 1), true)).toContain(
      "### cli 0.1.9\n\n_No tasks._",
    );
  });

  test("a note's fenced code keeps its # lines; markers and leading Markdown in titles and notes are escaped", () => {
    const note =
      "## Details\n```sh\n# a shell comment\nspider release check\n```\n# After";
    expect(flattenHeadings(note)).toBe(
      "**Details**\n```sh\n# a shell comment\nspider release check\n```\n**After**",
    );

    expect(
      escapeMarkers(
        "a <!-- /spider:changelog --> b <!-- spider:changelog hash=0000aaaa --> <!--spider:release ST-1 -->",
      ),
    ).toBe(
      "a &lt;!-- /spider:changelog --> b &lt;!-- spider:changelog hash=0000aaaa --> &lt;!--spider:release ST-1 -->",
    );
    const sneaky = [
      {
        key: "ST-7",
        title: "**Bold** <!-- /spider:changelog -->",
        whatChanged: "Ends it <!-- /spider:changelog -->\nmore",
        apps: [],
      },
    ];
    const markdown = renderChangelog([], sneaky, false);
    expect(markdown).toBe(
      "- **ST-7** \\*\\*Bold** &lt;!-- /spider:changelog -->\n  Ends it &lt;!-- /spider:changelog -->\n  more",
    );
    // The block written with it reads back whole, not as a hand edit.
    const description = withChangelog("Intro.", markdown);
    expect(changelogBlock(description)).toEqual({
      content: markdown,
      edited: false,
    });
    expect(changelogState(description, markdown)).toBe("current");
    expect(
      renderChangelog(
        [],
        [
          {
            key: "ST-8",
            title: "# Not a heading",
            whatChanged: null,
            apps: [],
          },
        ],
        false,
      ),
    ).toBe("- **ST-8** \\# Not a heading");
    expect(
      renderChangelog(
        [],
        [{ key: "ST-9", title: "_x_ and *y*", whatChanged: null, apps: [] }],
        false,
      ),
    ).toBe("- **ST-9** \\_x_ and *y*");
  });

  test("appNotes takes one app's section", () => {
    const markdown = renderChangelog(apps, entries, true);
    expect(appNotes(markdown, "cli")).toBe("- **ST-2** Shared");
    expect(appNotes(markdown, "web")).toBe(
      "- **ST-1** Board\n  - Columns\n  **Details**\n  - More\n- **ST-2** Shared",
    );
    expect(appNotes(markdown, "api")).toBeNull();
  });
});

describe("the changelog block in a description", () => {
  test("appended after the text, replaced in place, edits noticed", () => {
    const first = withChangelog("Release owner notes.", "- **ST-1** A");
    expect(first).toMatch(
      /^Release owner notes\.\n\n<!-- spider:changelog hash=[0-9a-f]{8} -->\n- \*\*ST-1\*\* A\n<!-- \/spider:changelog -->$/,
    );
    expect(changelogBlock(first)).toEqual({
      content: "- **ST-1** A",
      edited: false,
    });
    expect(changelogState(first, "- **ST-1** A")).toBe("current");
    expect(changelogState(first, "- **ST-1** A\n- **ST-2** B")).toBe(
      "outdated",
    );
    expect(changelogState("No block", "x")).toBe("missing");
    expect(changelogState(null, "x")).toBe("missing");

    const second = withChangelog(
      `${first}\n\nMore notes after.`,
      "- **ST-2** B",
    );
    expect(
      second.startsWith("Release owner notes.\n\n<!-- spider:changelog"),
    ).toBe(true);
    expect(
      second.endsWith("<!-- /spider:changelog -->\n\nMore notes after."),
    ).toBe(true);
    expect(changelogBlock(second)?.content).toBe("- **ST-2** B");

    const edited = second.replace("- **ST-2** B", "- **ST-2** B, reworded");
    expect(changelogBlock(edited)).toEqual({
      content: "- **ST-2** B, reworded",
      edited: true,
    });
    expect(changelogState(edited, "- **ST-2** B")).toBe("edited");
    expect(withChangelog(null, "x")).toMatch(/^<!-- spider:changelog/);
  });

  test("finishChangelog and regroupChangelog", () => {
    const base: Omit<
      ReleaseChangelogDto,
      "markdown" | "description" | "written"
    > = {
      release: { id: "r", key: "ST-9", title: "2026.10.13" },
      apps: [
        {
          name: "web",
          repo: "o/r",
          version: "2026.10.13",
          tag: "web-2026.10.13",
        },
        { name: "cli", repo: "o/r", version: "0.1.9", tag: "cli-v0.1.9" },
      ],
      grouped: false,
      entries: [
        {
          key: "ST-1",
          title: "Board",
          projectKey: "ST",
          whatChanged: null,
          handoff: null,
          apps: [],
        },
        {
          key: "ST-2",
          title: "CLI",
          projectKey: "ST",
          whatChanged: null,
          handoff: null,
          apps: [],
        },
      ],
    };
    const flat = finishChangelog(base, null);
    expect(flat).toMatchObject({
      grouped: false,
      description: { state: "missing", content: null },
      written: null,
    });
    expect(flat.markdown.startsWith("### Changes")).toBe(true);

    const grouped = regroupChangelog(flat, {
      "ST-1": ["web", "api"],
      "ST-2": ["cli"],
      "ST-7": ["web"],
    });
    expect(grouped.entries.map((e) => e.apps)).toEqual([["web"], ["cli"]]);
    expect(grouped.markdown).toBe(
      "### web 2026.10.13\n\n- **ST-1** Board\n\n### cli 0.1.9\n\n- **ST-2** CLI",
    );
    expect(grouped.description.state).toBe("missing");

    const written = finishChangelog(base, withChangelog("", grouped.markdown));
    expect(written.description.state).toBe("outdated");
    expect(
      regroupChangelog(written, { "ST-1": ["web"], "ST-2": ["cli"] })
        .description.state,
    ).toBe("current");
  });
});

describe("CHANGELOG.md", () => {
  const release = { key: "ST-120", title: "2026.10.13" };
  const section = changelogFileSection(
    release,
    "2026-10-13",
    "### web 2026.10.13\n\n- **ST-1** Board",
  );
  test("the release goes after Unreleased, once", () => {
    expect(section).toBe(
      "## 2026.10.13 (ST-120, 2026-10-13)\n<!-- spider:release ST-120 -->\n\n### web 2026.10.13\n\n- **ST-1** Board\n",
    );
    const file =
      "# Changelog\n\nIntro.\n\n## Unreleased\n\n### CLI\n\n- x\n\n## 2026.10.01 (ST-100, 2026-10-01)\n\n- old\n";
    const { text, inserted } = insertReleaseSection(file, release, section);
    expect(inserted).toBe(true);
    expect(text).toBe(
      "# Changelog\n\nIntro.\n\n## Unreleased\n\n### CLI\n\n- x\n\n" +
        section +
        "\n## 2026.10.01 (ST-100, 2026-10-01)\n\n- old\n",
    );
    expect(insertReleaseSection(text, release, section)).toEqual({
      text,
      inserted: false,
    });
  });

  test("no Unreleased section, no sections at all, an empty file", () => {
    expect(
      insertReleaseSection("# Changelog\n\n## 1.0\n- a\n", release, section)
        .text,
    ).toBe(`# Changelog\n\n${section}\n## 1.0\n- a\n`);
    expect(
      insertReleaseSection(
        "# Changelog\n\n## Unreleased\n\n- a\n",
        release,
        section,
      ).text,
    ).toBe(`# Changelog\n\n## Unreleased\n\n- a\n\n${section}`);
    expect(insertReleaseSection("", release, section).text).toBe(section);
  });
});
