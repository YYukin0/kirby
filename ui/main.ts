// ============================================================================
// Typewriter Plan — a pixel-Kirby desktop pet holding your study plan.
//
// There is NO import/paste UI. To load a plan, an LLM (or you) simply writes
// Markdown into the single plan file below. The pet reads it, shows only THREE
// rows at a time (刚完成 / 正在做 / 下一个), and you click to roll forward/back.
// It auto-refreshes when the file changes, and writes your progress back.
//
//  ┌─────────────────────────────────────────────────────────────────────┐
//  │  CHANGE YOUR VAULT PATH HERE                                          │
//  └─────────────────────────────────────────────────────────────────────┘
const VAULT_PATH = "/Users/yyukin0/Documents/obsidian"; // <-- your Obsidian vault root
const SUBDIR = "Study Plans";                            // <-- subfolder for the plan
const PLAN_FILE = `${VAULT_PATH}/${SUBDIR}/current.md`;  // the one file the pet shows
// ============================================================================

const AUTOSAVE_DELAY_MS = 800; // debounce before writing progress to disk
const POLL_MS = 2500;          // how often to check the file for LLM edits

// --- Tauri bridge (withGlobalTauri = true, so no bundler / npm import needed) ---
const T: any = (window as any).__TAURI__;
const invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> = T.core.invoke;

// --- Pixel Kirby sprite (the art you approved) ------------------------------
const PET_MAP = [
  "......pppp......",
  "....pppppppp....",
  "...pppppppppp...",
  "..pppppppppppp..",
  "..pppppppppppp..",
  "..pppwwppwwppp..",
  ".ppppeeppeepppp.",
  "pppppeeppeeppppp",
  "pppppppmmppppppp",
  "..pppppppppppp..",
  "..pppppppppppp..",
  "...pppppppppp...",
  "..ffff....ffff..",
  "..ffff....ffff..",
  "..ffff....ffff..",
];
const PET_COLORS: Record<string, string> = {
  p: "#f7a8cd", e: "#2a2c66", w: "#ffffff", f: "#ef5f86", m: "#c85c88",
};
function buildPet(): string {
  const S = 7;
  const cols = PET_MAP[0].length, rows = PET_MAP.length;
  let svg = `<svg width="${cols * S}" height="${rows * S}" viewBox="0 0 ${cols * S} ${rows * S}" xmlns="http://www.w3.org/2000/svg">`;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const ch = PET_MAP[r][c];
      if (ch === ".") continue;
      svg += `<rect x="${c * S}" y="${r * S}" width="${S}" height="${S}" fill="${PET_COLORS[ch]}"/>`;
    }
  return svg + "</svg>";
}

// --- Data model -------------------------------------------------------------
type Item =
  | { kind: "heading"; level: number; text: string }
  | { kind: "task"; text: string; initDone: boolean }
  | { kind: "note"; text: string }
  | { kind: "blank" };

interface PlanState {
  title: string;
  created: string;
  items: Item[];
  taskIdx: number[]; // indices into items[] that are tasks, in order
  cursor: number;    // how many tasks are completed (linear progress)
}

let state: PlanState = { title: "", created: "", items: [], taskIdx: [], cursor: 0 };
let saveTimer: number | undefined;
let lastContent = ""; // last file text we read or wrote — to detect external (LLM) edits

// --- DOM refs ---------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
const ptitle = $("ptitle");
const progEl = $("prog");
const tasksEl = $("tasks");
const savedEl = $("saved");
const petEl = $("pet");

// --- Parsing ----------------------------------------------------------------
function parse(text: string): Item[] {
  const items: Item[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") { items.push({ kind: "blank" }); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { items.push({ kind: "heading", level: h[1].length, text: h[2].trim() }); continue; }
    const cb = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (cb) { items.push({ kind: "task", initDone: cb[1].toLowerCase() === "x", text: cb[2].trim() }); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { items.push({ kind: "task", initDone: false, text: bullet[1].trim() }); continue; }
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (num) { items.push({ kind: "task", initDone: false, text: num[1].trim() }); continue; }
    items.push({ kind: "note", text: line.trim() });
  }
  return items;
}

function taskText(taskPos: number): string {
  const it = state.items[state.taskIdx[taskPos]];
  return it && it.kind === "task" ? it.text : "";
}

// Title = first heading in the plan. No fabricated fallback name.
function firstHeading(items: Item[]): string {
  const h = items.find((i) => i.kind === "heading") as { text: string } | undefined;
  return h && h.text ? h.text : "";
}

// --- Dates ------------------------------------------------------------------
const pad = (n: number) => (n < 10 ? "0" + n : String(n));
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDateTime = (d: Date) => `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtClock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// --- Rendering the 3-row window ---------------------------------------------
function checkSvg(): string {
  return '<span class="check"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6.5 L5 9 L10 3" fill="none" stroke="#0d0f12" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
}
function makeRow(taskPos: number, cls: string, tag: string, onClick?: () => void): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row " + cls;
  li.innerHTML = `<span class="tag">${tag}</span>${checkSvg()}<span class="label"></span>`;
  li.querySelector(".label")!.textContent = taskText(taskPos);
  if (onClick) li.onclick = onClick;
  return li;
}
function render(): void {
  ptitle.textContent = state.title || "今天的计划";
  const total = state.taskIdx.length;
  progEl.textContent = `${state.cursor} / ${total}`;

  tasksEl.innerHTML = "";
  if (total === 0) {
    const li = document.createElement("li");
    li.className = "row alldone empty";
    li.innerHTML = '<span class="tag">还没有计划 · 让 Claude 帮你写一份</span>';
    tasksEl.appendChild(li);
    return;
  }
  if (state.cursor - 1 >= 0) tasksEl.appendChild(makeRow(state.cursor - 1, "done", "刚完成", rollBack));
  if (state.cursor < total) tasksEl.appendChild(makeRow(state.cursor, "active", "正在做", complete));
  else {
    const li = document.createElement("li");
    li.className = "row alldone";
    li.innerHTML = '<span class="tag">全部完成 🎉</span>';
    tasksEl.appendChild(li);
  }
  if (state.cursor + 1 < total) tasksEl.appendChild(makeRow(state.cursor + 1, "next", "下一个"));
}

function cheer(): void {
  petEl.classList.add("happy");
  setTimeout(() => petEl.classList.remove("happy"), 500);
}
function complete(): void {
  if (state.cursor < state.taskIdx.length) { state.cursor++; cheer(); render(); scheduleSave(); }
}
function rollBack(): void {
  if (state.cursor > 0) { state.cursor--; render(); scheduleSave(); }
}

// --- Serialization (whole plan -> markdown) ---------------------------------
function toMarkdown(): string {
  const total = state.taskIdx.length;
  const fm = [
    "---",
    `title: ${state.title}`,
    `created: ${state.created}`,
    `updated: ${fmtDateTime(new Date())}`,
    `progress: ${state.cursor}/${total}`,
    "---",
  ];
  // task done state is driven purely by the linear cursor
  const donePos = new Map<number, boolean>();
  state.taskIdx.forEach((_, pos) => donePos.set(state.taskIdx[pos], pos < state.cursor));

  const body: string[] = [];
  state.items.forEach((it, idx) => {
    if (it.kind === "blank") body.push("");
    else if (it.kind === "heading") body.push("#".repeat(it.level) + " " + it.text);
    else if (it.kind === "note") body.push(it.text);
    else body.push(`- [${donePos.get(idx) ? "x" : " "}] ${it.text}`);
  });
  return fm.join("\n") + "\n\n" + body.join("\n") + "\n";
}

// --- Deserialization --------------------------------------------------------
function splitFrontmatter(text: string): { fm: Record<string, string>; body: string } {
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

// --- Saving -----------------------------------------------------------------
function scheduleSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, AUTOSAVE_DELAY_MS);
}
async function save(): Promise<void> {
  if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined; }
  if (state.items.length === 0) return;
  const md = toMarkdown();
  try {
    await invoke("write_atomic", { path: PLAN_FILE, contents: md });
    lastContent = md; // so our own write doesn't look like an external edit
    savedEl.textContent = `已保存 ${fmtClock(new Date())}`;
  } catch (e) {
    savedEl.textContent = "保存失败";
    console.error(e);
  }
}

// --- Load from the plan file ------------------------------------------------
function adopt(items: Item[], created: string): void {
  const taskIdx: number[] = [];
  items.forEach((it, i) => { if (it.kind === "task") taskIdx.push(i); });
  // cursor = number of leading completed tasks (first not-done task)
  let cursor = taskIdx.length;
  for (let pos = 0; pos < taskIdx.length; pos++) {
    const it = items[taskIdx[pos]];
    if (it.kind === "task" && !it.initDone) { cursor = pos; break; }
  }
  state = { title: firstHeading(items), created: created || fmtDate(new Date()), items, taskIdx, cursor };
  render();
}

async function loadFile(): Promise<void> {
  try {
    const text = await invoke("read_text", { path: PLAN_FILE });
    lastContent = text;
    const { fm, body } = splitFrontmatter(text);
    adopt(parse(body), fm.created || "");
    if (fm.title) { state.title = fm.title; render(); }
  } catch {
    // File not there yet — empty state; keep polling so it appears once written.
    lastContent = "";
    state = { title: "", created: "", items: [], taskIdx: [], cursor: 0 };
    render();
  }
}

// Poll for external (LLM) edits and reload when the file changed under us,
// unless we have a pending save (don't clobber the user's in-flight clicks).
async function poll(): Promise<void> {
  if (saveTimer !== undefined) return;
  try {
    const text = await invoke("read_text", { path: PLAN_FILE });
    if (text !== lastContent) await loadFile();
  } catch {
    if (lastContent !== "") await loadFile(); // file was removed
  }
}

// --- Wire up ----------------------------------------------------------------
const boardEl = document.querySelector(".board") as HTMLElement;
petEl.innerHTML = buildPet();
// Click the pet to collapse / expand the task board (drag still moves the
// window). The pet itself stays put — no hop here.
petEl.addEventListener("click", () => {
  boardEl.classList.toggle("collapsed");
});
$("close").addEventListener("click", async () => {
  try { await T.window.getCurrentWindow().close(); } catch (e) { console.error(e); }
});

loadFile();
setInterval(poll, POLL_MS);
