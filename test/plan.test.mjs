// Unit tests for the pure plan model (ui/plan.ts -> ui/plan.js).
// Run with `npm test` (compiles first, then `node --test test/`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parse, splitFrontmatter, firstHeading, deriveCursor, serializePlan, cleanTaskText,
} from "../ui/plan.js";

test("splitFrontmatter reads keys, or passes through when absent", () => {
  const withFm = "---\ntitle: Demo\ncreated: 2026-08-08\n---\n\n# Demo\n- [ ] a\n";
  const a = splitFrontmatter(withFm);
  assert.equal(a.fm.title, "Demo");
  assert.equal(a.fm.created, "2026-08-08");
  assert.equal(a.body, "# Demo\n- [ ] a\n");

  const noFm = "# Just a heading\n- [ ] a\n";
  const b = splitFrontmatter(noFm);
  assert.deepEqual(b.fm, {});
  assert.equal(b.body, noFm);
});

test("parse classifies headings, tasks, notes and blanks", () => {
  const items = parse("# Title\n\n- [x] done one\n- [ ] todo two\n* bullet three\n1. numbered four\njust a note\n");
  assert.deepEqual(items.map((i) => i.kind), [
    "heading", "blank", "task", "task", "task", "task", "note", "blank",
  ]);
  assert.equal(items[0].text, "Title");
  assert.equal(items[2].initDone, true);
  assert.equal(items[3].initDone, false);
  assert.equal(items[4].text, "bullet three");   // bullets become undone tasks
  assert.equal(items[5].text, "numbered four");  // numbered too
  assert.equal(items[6].text, "just a note");
});

test("cleanTaskText strips inline markdown", () => {
  assert.equal(cleanTaskText("**bold** and _italic_ and `code`"), "bold and italic and code");
});

test("firstHeading returns the first heading, else empty", () => {
  assert.equal(firstHeading(parse("- [ ] a\n# Later\n")), "Later");
  assert.equal(firstHeading(parse("- [ ] a\n")), "");
});

test("deriveCursor: leading done tasks set the linear cursor", () => {
  const { cursor, nonLinear, taskIdx } = deriveCursor(parse("- [x] a\n- [x] b\n- [ ] c\n"));
  assert.equal(cursor, 2);
  assert.equal(nonLinear, false);
  assert.equal(taskIdx.length, 3);
});

test("deriveCursor: all done", () => {
  const { cursor, nonLinear } = deriveCursor(parse("- [x] a\n- [x] b\n"));
  assert.equal(cursor, 2);
  assert.equal(nonLinear, false);
});

test("deriveCursor: empty plan", () => {
  const { cursor, nonLinear, taskIdx } = deriveCursor(parse("# Only a title\n"));
  assert.equal(cursor, 0);
  assert.equal(nonLinear, false);
  assert.equal(taskIdx.length, 0);
});

test("deriveCursor: non-linear file is detected, cursor stays at first gap", () => {
  const { cursor, nonLinear } = deriveCursor(parse("- [x] a\n- [ ] b\n- [x] c\n- [ ] d\n"));
  assert.equal(cursor, 1);        // first not-done is b
  assert.equal(nonLinear, true);  // c is checked past the gap
});

test("serializePlan: checkbox state follows the cursor, not the input", () => {
  const items = parse("# Plan\n\n- [x] a\n- [ ] b\n- [x] c\n- [ ] d\n");
  const { taskIdx } = deriveCursor(items);
  // Pretend the user advanced the cursor to 2.
  const md = serializePlan(
    { title: "Plan", created: "2026-08-08", items, taskIdx, cursor: 2 },
    new Date(2026, 7, 8, 14, 30),
  );
  assert.match(md, /^---\n/);
  assert.match(md, /progress: 2\/4/);
  assert.match(md, /updated: 2026-08-08 14:30/);
  // First two checked, last two not — the stray [x] c is squared up.
  assert.match(md, /- \[x\] a\n- \[x\] b\n- \[ \] c\n- \[ \] d\n/);
});

test("serializePlan round-trips headings, notes and blanks", () => {
  const src = "# Title\n\nsome note\n\n- [x] a\n- [ ] b\n";
  const items = parse(src);
  const { taskIdx, cursor } = deriveCursor(items);
  const md = serializePlan({ title: "Title", created: "2026-08-08", items, taskIdx, cursor }, new Date(2026, 7, 8, 9, 5));
  // Re-parsing the body reproduces the same structure (ignoring the trailing
  // blank the serializer always appends).
  const body = splitFrontmatter(md).body;
  const trimTrailingBlanks = (arr) => { const a = arr.map((i) => i.kind); while (a.at(-1) === "blank") a.pop(); return a; };
  assert.deepEqual(trimTrailingBlanks(parse(body)), trimTrailingBlanks(items));
  assert.match(md, /updated: 2026-08-08 09:05/);
});
