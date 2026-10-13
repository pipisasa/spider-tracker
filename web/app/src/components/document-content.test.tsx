import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentContent } from "./document-content";

const host = {
  href: (target: string) =>
    target.split("#")[0] === "Plan" ? "/org/docs/1" : null,
  open: () => {},
};

test("renders [[links]]: found ones with an href, missing ones dimmed, code untouched (ST-100)", () => {
  const out = renderToStaticMarkup(
    <DocumentContent
      format="md"
      content={
        "See [[Plan|the plan]] and [[Nope]], not `[[Code]]`.\n\n- [[Plan#Goals]]"
      }
      wikiLinks={host}
    />,
  );
  expect(out).toContain(
    '<a class="wiki-link" href="/org/docs/1" data-target="Plan">the plan</a>',
  );
  expect(out).toContain(
    '<a class="wiki-link wiki-link-missing" data-target="Nope">Nope</a>',
  );
  expect(out).toContain("<code>[[Code]]</code>");
  expect(out).toContain(
    '<a class="wiki-link" href="/org/docs/1" data-target="Plan#Goals">Plan#Goals</a>',
  );
});

test("[[doc:<id>]] shows the document's title unless the link has a label (ST-115)", () => {
  const byId = {
    href: (target: string) => (target === "doc:1" ? "/org/docs/1" : null),
    label: (target: string) => (target === "doc:1" ? "Plan" : null),
    open: () => {},
  };
  const out = renderToStaticMarkup(
    <DocumentContent
      format="md"
      content={"[[doc:1]] and [[doc:1|see this]]"}
      wikiLinks={byId}
    />,
  );
  expect(out).toContain(
    '<a class="wiki-link" href="/org/docs/1" data-target="doc:1">Plan</a>',
  );
  expect(out).toContain(
    '<a class="wiki-link" href="/org/docs/1" data-target="doc:1">see this</a>',
  );
});
