import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TargetDate, formatDay } from "./task-fields";

// The target date shown on list rows and board cards (ST-91, ST-133).

test("a target date in the past is marked overdue while the task is open", () => {
  const html = renderToStaticMarkup(
    <TargetDate task={{ targetDate: "2020-01-10" }} category="in_progress" />,
  );
  expect(html).toContain(formatDay("2020-01-10"));
  expect(html).toContain("(overdue)");
  expect(html).toContain("text-destructive");
});

test("a closed task, or a future date, is not overdue; no date shows nothing", () => {
  const done = renderToStaticMarkup(
    <TargetDate task={{ targetDate: "2020-01-10" }} category="done" />,
  );
  expect(done).not.toContain("(overdue)");
  expect(done).toContain('title="Target 2020-01-10"');
  expect(
    renderToStaticMarkup(
      <TargetDate task={{ targetDate: "2999-01-01" }} category="todo" />,
    ),
  ).not.toContain("(overdue)");
  expect(
    renderToStaticMarkup(
      <TargetDate task={{ targetDate: null }} category="todo" />,
    ),
  ).toBe("");
});
