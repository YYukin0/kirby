# Kirby 计划提示词模板

把这个提示词存到 Claude 的「项目指令」或「记忆」里。之后你只要说：

> 帮我列一份明天 Kirby 计划

Claude 就会按下面的规则自动写好。

---

## 系统指令

当用户要求你写/更新学习计划，并且提到了「Kirby」或「Typewriter Plan」时，请执行以下步骤：

1. **目标文件**：把计划写入
   ```
   /Users/yyukin0/Documents/obsidian/Study Plans/current.md
   ```
   如果文件已存在，**保留已有进度**（`- [x]` 的任务不要改回 `- [ ]`），只更新标题、日期、`progress` 和后续任务。

2. **文件格式**：必须包含 frontmatter + Markdown 任务列表。

3. **任务列表规则**：
   - 每行一个任务，格式：`- [ ] 任务描述` 或 `- [x] 任务描述`。
   - 任务描述保持简洁，**不要嵌套子任务**。
   - 可以保留题号、难度、简短备注，例如：`- [ ] 19. Remove Nth Node From End of List (Medium)`。
   - 不要用加粗 `**`、斜体 `_`、行内代码 `` ` `` 包裹任务文本。
   - 不要出现 `1.`、`2)` 这种数字列表，统一用 `- [ ]` 复选框。

4. **Frontmatter 规则**：
   ```yaml
   ---
   title: 计划标题
   created: YYYY-MM-DD
   updated: YYYY-MM-DD HH:MM
   progress: N/M
   ---
   ```
   - `title` 取正文第一个 `# ` 标题，两者保持一致。
   - `created` 保留原文件的日期；如果是新文件，用今天日期。
   - `updated` 用当前日期时间。
   - `progress` 根据已完成任务数自动计算：`已完成数 / 总任务数`。

5. **标题层级**：只用一个 `# 计划标题`，下面直接跟任务列表。如果计划跨度多天，可以用 `## Day N` 分组，但每组下面仍必须是平级的 `- [ ]` 任务。

---

## 示例输出

```markdown
---
title: 链表 Medium 进阶
created: 2026-08-08
updated: 2026-08-08 04:12
progress: 0/5
---

# 链表 Medium 进阶

- [ ] 19. Remove Nth Node From End of List (Medium)
- [ ] 142. Linked List Cycle II (Medium)
- [ ] 92. Reverse Linked List II (Medium)
- [ ] 21. Merge Two Sorted Lists (Easy)
- [ ] 82. Remove Duplicates from Sorted List II (Medium)
```

---

## 更新已有计划的示例

如果 `current.md` 里已有：

```markdown
---
title: 链表 Medium 进阶
created: 2026-08-08
updated: 2026-08-08 01:00
progress: 2/5
---

# 链表 Medium 进阶

- [x] 19. Remove Nth Node From End of List (Medium)
- [x] 142. Linked List Cycle II (Medium)
- [ ] 92. Reverse Linked List II (Medium)
- [ ] 21. Merge Two Sorted Lists (Easy)
- [ ] 82. Remove Duplicates from Sorted List II (Medium)
```

用户说「再加两题」，你应该保留 `- [x]` 状态，把新任务追加到列表末尾，并更新 `progress`：

```markdown
---
title: 链表 Medium 进阶
created: 2026-08-08
updated: 2026-08-08 04:15
progress: 2/7
---

# 链表 Medium 进阶

- [x] 19. Remove Nth Node From End of List (Medium)
- [x] 142. Linked List Cycle II (Medium)
- [ ] 92. Reverse Linked List II (Medium)
- [ ] 21. Merge Two Sorted Lists (Easy)
- [ ] 82. Remove Duplicates from Sorted List II (Medium)
- [ ] 25. Reverse Nodes in k-Group (Hard)
- [ ] 138. Copy List with Random Pointer (Medium)
```

---

## 用户话术示例

你可以这样跟 Claude 说：

- 「帮我列一份明天 Kirby 计划，5 道链表 Medium。」
- 「Kirby，把今天的计划改成 3 道树 + 2 道图。」
- 「在当前计划后面追加 3 道 DP。」
- 「把明天的计划清空，重新排 8 道字符串。」

Claude 会理解「Kirby」指代这个桌面小组件，并自动写到 `current.md`。
