# Kirby 任务列表输入流程优化草案

> 目标：让「把计划交给 LLM，LLM 写进 `current.md`，Kirby 自动显示」这条路更顺滑、更不容易出错，同时保持「零编辑 UI」的极简定位。

---

## 1. 当前流程回顾

```
用户口述/粘贴目标  →  Claude 写成 Markdown  →  保存到
                        /Users/yyukin0/Documents/obsidian/Study Plans/current.md
                                            ↓
                                Kirby 轮询读取（≈2.5s）
                                            ↓
                                显示 刚完成 / 正在做 / 下一个
```

**优点**：没有导入界面， Plans/current.md 就行。  
**瓶颈**：
- 用户每次都要想起「让 Claude 写到某个固定路径」；
- 计划格式没有约束，LLM 容易写出 Kirby 识别不了的列表（比如嵌套任务、复选框混合自由文本、任务带时长/标签等）；
- 一份计划做久了想换主题，只能手动改名/改文件；
- 没有「让 LLM 基于当前进度继续拆分下一步」的闭环。

---

## 2. 优化方向（按优先级）

### 2.1 短期：给 LLM 一个稳定的「喂计划」提示词

与其每次让用户临场发挥，不如内置一个 Claude 指令片段。用户只需要说：

```
/plan 本周刷完链表 Medium 题
```

Claude 就按固定格式输出到 `current.md`：

```markdown
---
title: 链表 Medium 冲刺
created: 2026-08-08
updated: 2026-08-08
progress: 0/5
---

# 链表 Medium 冲刺

- [ ] 19. Remove Nth Node From End of List
- [ ] 142. Linked List Cycle II
- [ ] 92. Reverse Linked List II
- [ ] 21. Merge Two Sorted Lists
- [ ] 82. Remove Duplicates from Sorted List II
```

**实现建议**：
- 在 README / 项目里放一个 `PROMPT.md`，把这段提示词直接贴进去；
- 用户可以把这段 prompt 存到 Claude 的「项目指令」或「记忆」里，以后每次自动生效。

---

### 2.2 短期：放宽并规范化 Markdown 解析

Kirby 目前只认 `- [ ]` / `- ` / `1.` 等简单行。LLM 经常输出：

```markdown
## Day 1
- [ ] 19. Remove Nth Node From End of List （20 min）
- [ ] 142. Linked List Cycle II [link](...)
  - 注意快慢指针边界
- [ ] 92. Reverse Linked List II
```

**建议增强 `parse()`**：
- 支持嵌套子任务：把缩进的子行也当成任务，或者折叠到父任务标签里显示；
- 保留括号、链接、标签作为纯文本，不要截断；
- 支持 `-[x]` / `-[X]` / `- [x]` 等常见变体；
- 对无法识别的行保留在文件里但不在卡片显示（现在已经做了一部分）。

**收益**：LLM 输出更自由，用户少修格式。

---

### 2.3 中期：多计划文件 + 快速切换

现在只认 `current.md`。可以扩展为：

```
Study Plans/
├── current.md          # 当前正在执行的计划
├── rust-crash.md
├── linked-list-week.md
└── archive/
    └── done-2026-08.md
```

Kirby 仍然只显示 `current.md`，但用户可以让 Claude：

```
切换到 rust-crash 计划
```

Claude 把 `rust-crash.md` 复制/软链成 `current.md`，Kirby 自动刷新。

**实现建议**：
- Rust 端加一个 `list_plans()` 命令，读取 `Study Plans/` 目录下所有 `.md`；
- 前端在卡片底部加一个极简的计划名指示器（只在 hover 时显示切换箭头）；
- 或者完全不做 UI，继续让 Claude 负责切换，只需要告诉 Claude「可用的计划文件列表」。

---

### 2.4 中期：让 Claude 能「读进度、续计划」

当前 LLM 只负责写计划，不参与进度反馈。可以设计一个闭环：

```
用户：我今天做了 3 个，帮我调整后面两天
Claude：读取 current.md  →  看到 progress: 3/8  →  重新分配剩余任务到 Day 2/3
        →  写回 current.md  →  Kirby 自动更新
```

**实现建议**：
- 在 frontmatter 里加 `days` / `dailyGoal` 等字段；
- 给 Claude 一个读取当前进度的指令，让它基于剩余任务重新排期；
- 保持文件仍然是唯一数据源，Kirby 只读不写标题/排期。

---

### 2.5 长期：系统级快捷输入（可选，但会复杂化）

如果希望完全不用打开 Claude 对话，可以考虑：

- **菜单栏模式**：Kirby 缩成菜单栏图标，点击弹出一个小输入框，用户打字或语音说计划，Kirby 把这段话存成一个临时文件，再让本地/远程 LLM 转成 `current.md`；
- **全局快捷键**：按 `⌃⌥K` 呼出一个 mini 输入浮窗，输入后发给 LLM；
- **与 Claude Code / MCP 集成**：写一个 MCP server，让 Claude Code 直接调用 Kirby 的 Rust 命令读写计划，用户在任何 Claude Code 会话里都能说「把这段加进 Kirby」。

**风险**：这会背离「极简打字机」的初衷。建议只在确定需要时才做。

---

## 3. 推荐的第一阶段改动

保持最小改动，先解决 80% 的 friction：

1. **写一个 `PROMPT.md`**，把「如何给 Kirby 写计划」的提示词固定下来；
2. **强化 `parse()`**：
   - 支持缩进子任务（可选显示为父任务的备注）；
   - 支持 `[标签]` / `(`备注`)` / 链接作为文本保留；
   - 兼容更多复选框写法；
3. **frontmatter 增加 `tags` 和 `dailyGoal`**，让 LLM 能写更结构化的计划；
4. **README 更新**：把「怎么让 Claude 写计划」写成一句可复制的话术。

这样用户以后只需要说：

> 「Kirby，帮我列一份本周链表进阶计划，每天 3 题。」

Claude 就知道格式、路径、文件名，直接写好。

---

## 4. 需要用户决定的事

- 要不要保留「零 UI」原则？（还是愿意加一点点菜单/快捷键）
- 计划文件是只保留 `current.md`，还是支持多份切换？
- 子任务/嵌套列表要不要显示在卡片上？还是只保留在文件里？
- 需不需要让 Claude 能基于当前进度主动提醒/调整计划？

---

## 5. 下一步

我可以先做 **第一阶段**：
- 写 `PROMPT.md`；
- 改 `ui/main.ts` 的 `parse()`，让它更宽容；
- 更新 README 的「怎么用 Claude 写计划」部分；
- 重新打包 `Kirby.app`。

如果你同意方向，告诉我从哪一条开始。
