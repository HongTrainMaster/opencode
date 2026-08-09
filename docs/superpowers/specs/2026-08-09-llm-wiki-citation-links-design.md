# llm-wiki 搜索引用：出处说明 + 原文预览链接 设计

日期：2026-08-09
状态：已批准

## 背景

用户在 opencode 的知识问答会话中，通过 llm-wiki 技能搜索知识库后，回答只以 `[[页面名]]` 形式标注来源，无法定位到业务系统里的原文文档。目标：搜索完成后，在回答的每条来源上附加**出处说明**（原文标题 + 业务文档 ID）和**打开原文预览的链接**。

预览文档 URL 规则：`{hostIP}/#/knowledge/document/detail/{id}`

## 决策

1. **改动位置：llm-wiki 技能本身**，opencode 仓库零改动。
2. **hostIP 来源：写在知识库配置** `.wiki-schema.md`（新增 `预览地址：` 字段），技能 query 工作流直接读取。
3. **文档 ID 映射：标题匹配 `wiki/sources/{id}.md`**。入库管线（opencode `summary-writer.ts`）会为每篇业务文档写 `wiki/sources/{documentId}.md`（`type: summary`，frontmatter 含完整 `title`），即「wiki/source/id.md」映射来源；搜索命中的 date-title 来源页按其 frontmatter `title:` 与数字命名页精确匹配得到 `documentId`。
4. **落地方式：新增 `scripts/resolve-source-id.sh` 脚本 + 修改 SKILL.md query 工作流**。
5. **变更载体：同步修改已安装技能与源仓库** 两份副本（`~/.agents/skills/llm-wiki` 与 `D:\hsl\llm-wiki-skill\llm-wiki-skill-main`）。两份副本现内容一致（SKILL.md 与 scripts 逐文件相同），改动后保持一致；两者均不在 git 中，以脚本自测覆盖。

## 关键事实（已核实）

- 技能 query 工作流（SKILL.md 工作流 4 第 4 步）是唯一在回答中生成 `[[页面名]]` 引用的地方 → 在此注入。
- 真实知识库 `D:\hsl\llm-wiki-skill\aistore`：来源页命名 `wiki/sources/{日期}-{短标题}.md`（部分无日期前缀），frontmatter 有 `title`、`source_path`、`sources` 等字段，无任何 `documentId` / `id` 字段。
- 真实库中唯一数字命名页 `wiki/sources/2084893088598257665.md`（`type: summary`，由入库写入）与日期标题页 `2025-09-19-河湖库监测感知方案征求意见函.md` 的 `title:` **完全相同**（`厅河湖长处关于征求《广东省河湖库一体化监测感知体系建设实施方案（2025—2027年）（征求意见稿）》意见的函`）→ 标题匹配可行。
- `.wiki-schema.md` 为简单 `key: value` 文本，新增 `预览地址：` 字段无兼容问题。
- opencode 仓库中不存在 `hostIP` / `knowledge/document/detail`；该路由位于独立业务前端（`bj-plus-ai-web`）。

## 架构

```
搜索命中来源页（date-title.md 或 {id}.md）
        │
        ▼
┌─────────────────────────────┐    ┌─────────────────────────────┐
│ scripts/resolve-source-id.sh │──►│ 读 .wiki-schema.md 的"预览地址" │
│  · 输出出处说明                │    └─────────────────────────────┘
│  · 输出 documentId（标题匹配）  │
└─────────────────────────────┘
        │  输出（JSON：title / sourcePath / documentId / previewBase / canLink）
        ▼
┌─────────────────────────────┐
│ SKILL.md 工作流4 · 第4步      │  综合回答时附加：
│  · 查预览地址                 │    **出处**：{原文标题}（文档ID {id}）
│  · 解析 documentId           │    **原文预览**：[打开原文]({hostIP}/#/knowledge/document/detail/{id})
│  · 生成出处说明+预览链接      │  （无 hostIP / 无 ID → 优雅降级）
└─────────────────────────────┘
```

### 新组件：`scripts/resolve-source-id.sh`

- **输入**：知识库根路径 + 来源页路径（`wiki/sources/*.md`，绝对或相对）。
- **输出**（stdout JSON）：
  ```json
  {
    "title": "原文标题（frontmatter title，兜底取文件名）",
    "sourcePath": "wiki/sources/xxx.md",
    "documentId": "2084893088598257665",   // 无匹配为空串 ""
    "previewBase": "http://192.168.0.101", // 未配置为 null
    "canLink": true                          // hostIP 与 documentId 齐备才为 true
  }
  ```
- **解析逻辑**：
  1. `previewBase`：读 `.wiki-schema.md` 的 `预览地址：` 字段（可含协议；末尾去 `/`）。
  2. 若 `sourcePath` 匹配 `^wiki/sources/[0-9]+\.md$` → `documentId` 直接取文件名数字。
  3. 否则扫描 `wiki/sources/[0-9]*\.md`，按 frontmatter `title:` 精确匹配 → `documentId` 取匹配文件数字名；匹配多个取**最早**（按文件名数字升序第一个），输出保留 `matchedSourcePath` 供人工核对。
  4. 无匹配 → `documentId: ""`。
- **风格**：沿用 `create-source-page.sh` 的 POSIX bash 风格；frontmatter 解析用 `awk`/`sed`（与现有脚本一致，不引入 Python 依赖）。

### 修改：`SKILL.md`

**通用前置检查** 新增一步：读取 `.wiki-schema.md` 中的 `预览地址` 字段，供后续工作流使用（可选，缺省 `null`）。

**工作流 4：query · 第 4 步「综合回答」** 追加：
1. 读取预览配置（`previewBase`，可为空）。
2. 对回答中实际引用的每个来源页，运行 `bash ${SKILL_DIR}/scripts/resolve-source-id.sh "<wiki_root>" "<来源页路径>"`。
3. 按下方格式为每条来源附加出处说明 + 预览链接。
4. 仅对回答中实际引用的来源页调用；解析失败（脚本非 0）则跳过该条，不阻塞回答。

**工作流 7：digest · 第 1 步「搜索相关页面」**：对将要综合的来源页用同一脚本附加出处说明与预览链接（报告「相关页面」段落），保持一致体验。

## 引用格式

回答引用来源时，除 `[[页面名]]` 外附加：

```
- [[水利北斗应用技术导则]]
  **出处**：水利北斗应用技术导则（征求意见稿）（文档ID 2084893088598257665）
  **原文预览**：[打开原文](http://192.168.0.101/#/knowledge/document/detail/2084893088598257665)
```

- `{hostIP}` 取自 `.wiki-schema.md` 的 `预览地址：` 字段。
- `{id}` 来自脚本输出的 `documentId`。
- hostIP 与 documentId 任一缺失 → 只输出能给出的部分（见降级策略）。

## 错误处理与降级

| 场景 | 行为 |
|---|---|
| `.wiki-schema.md` 无 `预览地址` | `previewBase=null`，只输出出处说明（标题+ID），无链接 |
| 来源页无匹配 `{id}.md` | `documentId=""`，输出出处说明（标题），无 ID、无链接 |
| 两者都无 | 退回现状（`[[页面名]]`） |
| 脚本执行失败 / 非 0 退出 | 跳过该来源的出处块，不阻塞回答，不报错 |
| 标题匹配到多个 `{id}.md` | 取最早（数字升序第一个）；输出保留 `matchedSourcePath` 供人工核对 |

## 测试

1. **单元**：`resolve-source-id.sh` 三个用例 —
   - `{id}.md` 直接命中（数字页）。
   - date-title 页 → 标题匹配出 `{id}.md`。
   - 无匹配 / 无预览地址 → 优雅降级。
2. **手工验证**：用 `D:\hsl\llm-wiki-skill\aistore` 真实库跑
   `bash scripts/resolve-source-id.sh "<root>" "wiki/sources/2025-09-19-河湖库监测感知方案征求意见函.md"`，
   预期输出 `documentId=2084893088598257665`。
3. **端到端**：临时在 `.wiki-schema.md` 加 `预览地址：http://192.168.0.101`，跑一遍完整 resolve，确认 `canLink=true` 且 URL 正确（`http://192.168.0.101/#/knowledge/document/detail/2084893088598257665`），随后还原配置。

## 影响面

- **修改文件**（两处同步）：
  - `~/.agents/skills/llm-wiki/SKILL.md` + `scripts/resolve-source-id.sh`
  - `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\SKILL.md` + `scripts/resolve-source-id.sh`
- **不涉及**：opencode 仓库、`summary-writer.ts`、`wiki-session.ts`、`ingest.ts`、业务前端、图谱（`store.ts`）。

## 已知限制

- 仅覆盖「通过 ingest 入库、写了 `{documentId}.md`」的文档；纯手工消化、无数字命名页的来源无法解析出 `documentId`（优雅降级为只给出处说明）。
- 标题匹配依赖两页 `title:` 完全一致；若手工编辑过标题导致不一致，将无法匹配（降级）。
