// ============================================================================
// Pure plan data-model: Markdown <-> items, linear cursor, serialization.
//
// Kept free of any DOM / Tauri so it can be unit-tested under node (see
// test/plan.test.mjs). main.ts imports these and wires them to the UI.
// ============================================================================

export type Item =
  | { kind: "heading"; level: number; text: string }
  | { kind: "task"; text: string; initDone: boolean }
  | { kind: "note"; text: string }
  | { kind: "blank" };

export function cleanTaskText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")   // bold
    .replace(/__([^_]+)__/g, "$1")       // bold alt
    .replace(/_([^_]+)_/g, "$1")         // italic
    .replace(/`([^`]+)`/g, "$1")         // inline code
    .trim();
}

// --- Parsing ----------------------------------------------------------------
export function parse(text: string): Item[] {
  const items: Item[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") { items.push({ kind: "blank" }); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { items.push({ kind: "heading", level: h[1].length, text: h[2].trim() }); continue; }
    const cb = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (cb) { items.push({ kind: "task", initDone: cb[1].toLowerCase() === "x", text: cleanTaskText(cb[2].trim()) }); continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) { items.push({ kind: "task", initDone: false, text: cleanTaskText(bullet[1].trim()) }); continue; }
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (num) { items.push({ kind: "task", initDone: false, text: cleanTaskText(num[1].trim()) }); continue; }
    items.push({ kind: "note", text: line.trim() });
  }
  return items;
}

// Title = first heading in the plan. No fabricated fallback name.
export function firstHeading(items: Item[]): string {
  const h = items.find((i) => i.kind === "heading") as { text: string } | undefined;
  return h && h.text ? h.text : "";
}

// --- Cursor derivation ------------------------------------------------------
// cursor = number of leading completed tasks (position of the first not-done
// task). nonLinear = a checked task sits past that first gap, so the file isn't
// linear and a save would rewrite those stray checks.
export function deriveCursor(items: Item[]): { taskIdx: number[]; cursor: number; nonLinear: boolean } {
  const taskIdx: number[] = [];
  items.forEach((it, i) => { if (it.kind === "task") taskIdx.push(i); });
  let cursor = taskIdx.length;
  for (let pos = 0; pos < taskIdx.length; pos++) {
    const it = items[taskIdx[pos]];
    if (it.kind === "task" && !it.initDone) { cursor = pos; break; }
  }
  let nonLinear = false;
  for (let pos = cursor; pos < taskIdx.length; pos++) {
    const it = items[taskIdx[pos]];
    if (it.kind === "task" && it.initDone) { nonLinear = true; break; }
  }
  return { taskIdx, cursor, nonLinear };
}

// --- Dates ------------------------------------------------------------------
const pad = (n: number) => (n < 10 ? "0" + n : String(n));
export const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtDateTime = (d: Date) => `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// --- Frontmatter ------------------------------------------------------------
export function splitFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fm: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") { end = i; break; }
  if (end === -1) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

// --- Serialization (whole plan -> markdown) ---------------------------------
// Task done state is driven purely by the linear cursor. `now` is passed in so
// the output is deterministic and testable.
export interface PlanSnapshot {
  title: string;
  created: string;
  items: Item[];
  taskIdx: number[];
  cursor: number;
}
export function serializePlan(s: PlanSnapshot, now: Date): string {
  const total = s.taskIdx.length;
  const fm = [
    "---",
    `title: ${s.title}`,
    `created: ${s.created}`,
    `updated: ${fmtDateTime(now)}`,
    `progress: ${s.cursor}/${total}`,
    "---",
  ];
  const donePos = new Map<number, boolean>();
  s.taskIdx.forEach((_, pos) => donePos.set(s.taskIdx[pos], pos < s.cursor));

  const body: string[] = [];
  s.items.forEach((it, idx) => {
    if (it.kind === "blank") body.push("");
    else if (it.kind === "heading") body.push("#".repeat(it.level) + " " + it.text);
    else if (it.kind === "note") body.push(it.text);
    else body.push(`- [${donePos.get(idx) ? "x" : " "}] ${it.text}`);
  });
  return fm.join("\n") + "\n\n" + body.join("\n") + "\n";
}
