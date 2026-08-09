# llm-wiki 搜索引用：出处说明 + 原文预览链接 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 opencode 会话中用 llm-wiki 技能查询知识库并引用来源时，回答为每条来源附加「出处说明」（原文标题 + 业务文档ID）和「原文预览链接」（`{hostIP}/#/knowledge/document/detail/{id}`）。

**Architecture:** 新增 `scripts/resolve-source-id.sh` 脚本，输入知识库根路径 + 来源页路径，输出 JSON（`title`/`sourcePath`/`documentId`/`previewBase`/`canLink`）；`documentId` 通过按 frontmatter `title:` 精确匹配 `wiki/sources/{数字}.md` 解析（入库管线已写这些文件）。修改 `SKILL.md` 的 query 工作流第 4 步与 digest 工作流第 1 步，让模型综合回答时为每条引用附加出处与预览链接。改动同步到已安装技能与源仓库两份副本。

**Tech Stack:** POSIX bash + 内联 Python（经 `shared-config.sh` 的 `require_python_cmd`），完全沿用现有 `cache.sh` / `create-source-page.sh` 的脚本风格与 `tests/*.regression-1.sh` 测试约定。**不引入任何新依赖。**

## Global Constraints

- **改动位置**：只改 llm-wiki 技能；opencode 仓库零改动（`D:\hsl\opencode` 只收本计划文档）。
- **hostIP 来源**：知识库 `.wiki-schema.md` 新增 `预览地址：` 字段（可含协议，如 `http://192.168.0.101`；末尾去 `/`）。
- **文档ID 映射**：按 frontmatter `title:` **精确匹配** `wiki/sources/{数字}.md`；`sourcePath` 本身是 `wiki/sources/{数字}.md` 时直接取文件名数字。
- **落地**：`scripts/resolve-source-id.sh`（新增）+ `SKILL.md`（query 工作流 4 第 4 步、digest 工作流 7 第 1 步、通用前置检查）。
- **引用格式**（每处引用附加）：
  ```
  **出处**：{title}（文档ID {documentId}）
  **原文预览**：[打开原文]({previewBase}/#/knowledge/document/detail/{documentId})
  ```
- **降级规则**：`previewBase` 为 null → 只给出处行、不给链接；`documentId` 为空 → 出处行只写 `{title}`；两者都无 → 保持原 `[[页面名]]`；脚本非 0 退出 → 跳过该条不阻塞回答。
- **脚本风格**：`set -euo pipefail` + `source "$SCRIPT_DIR/shared-config.sh"` + `require_python_cmd` + 内联 Python heredoc（与 `cache.sh` 一致）。frontmatter 解析用 Python（UTF-8/BOM 健壮），不用 awk/sed —— 这是对规范「用 awk/sed」的落地细化，遵循现有代码库约定。
- **变更载体**：源仓库 `D:\hsl\llm-wiki-skill\llm-wiki-skill-main`（开发 + 测试）+ 已安装技能 `C:\Users\Administrator\.agents\skills\llm-wiki`（同步）。两份副本当前逐文件相同，改后须保持相同。**两者均不在 git 中**：不执行 `git commit`（skill 文件），改以「回归测试通过 + 双副本 `diff -q` 一致」作为每任务验证；本计划文档在 opencode 仓库 git 提交。
- **两副本基础路径**：源码仓库根 `SRC="D:\hsl\llm-wiki-skill\llm-wiki-skill-main"`；已安装根 `INST="C:\Users\Administrator\.agents\skills\llm-wiki"`。

---

### Task 1: 新增 `scripts/resolve-source-id.sh`（含回归测试）

**Files:**
- Create: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\scripts\resolve-source-id.sh`
- Create: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\tests\resolve-source-id.regression-1.sh`
- Create: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\tests\fixtures\resolve-id-sample-wiki\.wiki-schema.md`
- Create: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\tests\fixtures\resolve-id-sample-wiki\wiki\sources\2084893088598257665.md`
- Create: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\tests\fixtures\resolve-id-sample-wiki\wiki\sources\2025-09-19-河湖库监测感知方案征求意见函.md`
- Create: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\tests\fixtures\resolve-id-sample-wiki\wiki\sources\2026-07-21-水利北斗应用技术导则.md`

**Interfaces:**
- Consumes: `shared-config.sh` 的 `require_python_cmd`（由 `cache.sh` 等现有脚本使用）。
- Produces: `resolve-source-id.sh <wiki_root> <source_page>` → stdout JSON：
  ```json
  { "title": "…", "sourcePath": "wiki/sources/….md", "documentId": "…", "previewBase": "http://…|null", "canLink": true|false }
  ```
  有匹配但 `sourcePath` 本身非数字页时，附加 `"matchedSourcePath": "wiki/sources/数字.md"`。Task 4 依赖此 JSON 字段名。
- 退出码：`0` 成功（无论能否解析出 ID）；`1` 参数错误 / 知识库根无效（非 `wiki/sources/*.md` 之外的一般错误）。

- [ ] **Step 1: 创建测试夹具**

创建 `tests/fixtures/resolve-id-sample-wiki/.wiki-schema.md`：

```markdown
wiki_name: 测试知识库
语言: 中文
预览地址：http://192.168.0.101
version: 1
created: 2026-08-09
schema_version: 3.6
```

> 注意：规范与现有 `.wiki-schema.md` 混用两种冒号——`wiki_name:` 用半角，`预览地址：` 用全角。脚本须两种都能解析（见 Step 4），测试夹具与真实库还原都用全角 `预览地址：`。

创建 `tests/fixtures/resolve-id-sample-wiki/wiki/sources/2084893088598257665.md`：

```markdown
---
title: 厅河湖长处关于征求《广东省河湖库一体化监测感知体系建设实施方案（2025—2027年）（征求意见稿）》意见的函
created: 2026-08-09
updated: 2026-08-09
type: summary
tags: []
sources: []
---

# 厅河湖长处关于征求《广东省河湖库一体化监测感知体系建设实施方案（2025—2027年）（征求意见稿）》意见的函

> 测试数字命名页（入库写入的 {documentId}.md）
```

创建 `tests/fixtures/resolve-id-sample-wiki/wiki/sources/2025-09-19-河湖库监测感知方案征求意见函.md`：

```markdown
---
type: source
title: 厅河湖长处关于征求《广东省河湖库一体化监测感知体系建设实施方案（2025—2027年）（征求意见稿）》意见的函
author: 广东省水利厅河湖长制工作处
date: 2025-09-19
tags: [水利, 广东, 河湖库, 监测感知]
confidence: EXTRACTED
---

# 厅河湖长处关于征求《广东省河湖库一体化监测感知体系建设实施方案（2025—2027年）（征求意见稿）》意见的函
```

创建 `tests/fixtures/resolve-id-sample-wiki/wiki/sources/2026-07-21-水利北斗应用技术导则.md`：

```markdown
---
type: source
title: 水利北斗应用技术导则（征求意见稿）
date: 2026-07-21
tags: [水利, 北斗]
---

# 水利北斗应用技术导则（征求意见稿）

> 无对应数字命名页，应解析出 documentId 为空。
```

- [ ] **Step 2: 编写回归测试（先失败）**

创建 `tests/resolve-source-id.regression-1.sh`（沿用 `tests/lint-output.regression-1.sh` 的 `set -eu` + PASS/FAIL 模式）：

```bash
#!/bin/bash
# resolve-source-id.regression-1.sh — 验证来源页 → 业务文档ID/预览地址 解析
set -eu

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$SKILL_DIR/tests/fixtures/resolve-id-sample-wiki"

# 用例1：date-title 页 → 按 title 精确匹配出 documentId，canLink=true
OUT1="$(bash "$SKILL_DIR/scripts/resolve-source-id.sh" "$FIXTURE" "wiki/sources/2025-09-19-河湖库监测感知方案征求意见函.md")"
printf '%s' "$OUT1" | grep -q '"documentId": "2084893088598257665"' || { echo "FAIL: date-title page did not resolve documentId"; echo "$OUT1"; exit 1; }
printf '%s' "$OUT1" | grep -q '"previewBase": "http://192.168.0.101"' || { echo "FAIL: previewBase missing"; echo "$OUT1"; exit 1; }
printf '%s' "$OUT1" | grep -q '"canLink": true' || { echo "FAIL: canLink should be true"; echo "$OUT1"; exit 1; }

# 用例2：数字页直接命中
OUT2="$(bash "$SKILL_DIR/scripts/resolve-source-id.sh" "$FIXTURE" "wiki/sources/2084893088598257665.md")"
printf '%s' "$OUT2" | grep -q '"documentId": "2084893088598257665"' || { echo "FAIL: numeric page should resolve directly"; echo "$OUT2"; exit 1; }

# 用例3a：无匹配 → documentId 为空，canLink=false
OUT3="$(bash "$SKILL_DIR/scripts/resolve-source-id.sh" "$FIXTURE" "wiki/sources/2026-07-21-水利北斗应用技术导则.md")"
printf '%s' "$OUT3" | grep -q '"documentId": ""' || { echo "FAIL: unmatched page should have empty documentId"; echo "$OUT3"; exit 1; }
printf '%s' "$OUT3" | grep -q '"canLink": false' || { echo "FAIL: canLink should be false when no documentId"; echo "$OUT3"; exit 1; }

# 用例3b：无预览地址 → previewBase=null，canLink=false
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -r "$FIXTURE/." "$TMP/"
sed -i.bak '/^预览地址：/d' "$TMP/.wiki-schema.md" && rm -f "$TMP/.wiki-schema.md.bak"
OUT4="$(bash "$SKILL_DIR/scripts/resolve-source-id.sh" "$TMP" "wiki/sources/2084893088598257665.md")"
printf '%s' "$OUT4" | grep -q '"previewBase": null' || { echo "FAIL: missing previewBase should be null"; echo "$OUT4"; exit 1; }
printf '%s' "$OUT4" | grep -q '"canLink": false' || { echo "FAIL: canLink should be false without previewBase"; echo "$OUT4"; exit 1; }

echo "PASS: resolve-source-id regression"
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bash "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\tests\resolve-source-id.regression-1.sh"`
Expected: 脚本 `resolve-source-id.sh` 不存在 → `scripts/resolve-source-id.sh: No such file`，退出非 0。

- [ ] **Step 4: 编写 `scripts/resolve-source-id.sh`**

创建 `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\scripts\resolve-source-id.sh`：

```bash
#!/bin/bash
# llm-wiki 来源页 → 业务文档ID / 预览地址 解析脚本
# 输出 stdout JSON：{ title, sourcePath, documentId, previewBase, canLink }
#   title        : frontmatter title（兜底取文件名 stem）
#   sourcePath   : 相对知识库根的来源页路径
#   documentId   : 数字命名页直接取文件名；否则按 title 精确匹配 wiki/sources/{数字}.md；无匹配为 ""
#   previewBase  : .wiki-schema.md 的"预览地址"字段；未配置为 null
#   canLink      : previewBase 与 documentId 齐备才为 true

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/shared-config.sh"

usage() {
  cat <<'EOF'
用法：
  bash scripts/resolve-source-id.sh <wiki_root> <source_page>

参数：
  wiki_root     : 知识库根目录（含 .wiki-schema.md）
  source_page   : 来源页路径（wiki/sources/*.md，绝对或相对 wiki_root）

输出（stdout JSON）：
  { "title": "...", "sourcePath": "...", "documentId": "...",
    "previewBase": "http://...|null", "canLink": true|false }
EOF
}

[ "$#" -eq 2 ] || { usage; exit 1; }

WIKI_ROOT="$1"
SOURCE_PAGE="$2"

[ -f "$WIKI_ROOT/.wiki-schema.md" ] || {
  echo "错误：$WIKI_ROOT 不是知识库根（缺 .wiki-schema.md）" >&2
  exit 1
}

require_python_cmd

# 规范化 source_page 为相对 wiki_root 的路径（复用 cache.sh 同款逻辑）
NORM_PAGE="$("$PYTHON_CMD" - "$WIKI_ROOT" "$SOURCE_PAGE" <<'PY'
import os
import sys
wiki_root = os.path.realpath(sys.argv[1])
source_page = os.path.realpath(sys.argv[2])
try:
    common = os.path.commonpath([wiki_root, source_page])
except ValueError:
    common = ""
if common == wiki_root:
    print(os.path.relpath(source_page, wiki_root))
else:
    print(sys.argv[2])
PY
)"

# 主逻辑：读 previewBase + frontmatter title + 解析 documentId
"$PYTHON_CMD" - "$WIKI_ROOT" "$NORM_PAGE" <<'PY'
import json
import os
import re
import sys

wiki_root, norm_page = sys.argv[1], sys.argv[2]

# 1. previewBase：读 .wiki-schema.md 的"预览地址"字段（半角/全角冒号都支持）
preview_base = None
schema_path = os.path.join(wiki_root, ".wiki-schema.md")
try:
    with open(schema_path, "r", encoding="utf-8-sig") as fh:
        for line in fh:
            if ":" in line or "：" in line:
                parts = re.split(r"[:：]", line, maxsplit=1)
                key = parts[0].strip()
                if key == "预览地址":
                    preview_base = parts[1].strip().rstrip("/") or None if len(parts) > 1 else None
                    break
except OSError:
    pass

# 2. title：frontmatter 的 title，兜底取文件名 stem
def read_frontmatter_title(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            text = fh.read()
    except OSError:
        return None
    m = re.match(r"^---\r?\n(.*?)\r?\n---", text, re.DOTALL)
    if not m:
        return None
    for line in m.group(1).splitlines():
        if line.startswith("title:"):
            return line[6:].strip()
    return None

title = os.path.splitext(os.path.basename(norm_page))[0]
fm_title = read_frontmatter_title(os.path.join(wiki_root, norm_page))
if fm_title:
    title = fm_title

# 3. documentId
document_id = ""
matched_path = ""
base = os.path.basename(norm_page)
if re.fullmatch(r"\d+\.md", base):
    document_id = base[:-3]
    matched_path = norm_page
else:
    sources_dir = os.path.join(wiki_root, "wiki", "sources")
    if os.path.isdir(sources_dir):
        try:
            numeric_files = sorted(f for f in os.listdir(sources_dir) if re.fullmatch(r"\d+\.md", f))
        except OSError:
            numeric_files = []
        for f in numeric_files:  # 已按文件名数字升序，取最早匹配
            if read_frontmatter_title(os.path.join(sources_dir, f)) == title:
                document_id = f[:-3]
                matched_path = os.path.join("wiki", "sources", f)
                break

result = {
    "title": title,
    "sourcePath": norm_page,
    "documentId": document_id,
    "previewBase": preview_base,
    "canLink": bool(preview_base and document_id),
}
if matched_path and matched_path != norm_page:
    result["matchedSourcePath"] = matched_path

print(json.dumps(result, ensure_ascii=False))
PY
```

- [ ] **Step 5: 运行回归测试确认通过**

Run: `bash "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\tests\resolve-source-id.regression-1.sh"`
Expected: `PASS: resolve-source-id regression`，退出 0。

- [ ] **Step 6: 权限 + 语法自检**

Run: `chmod +x "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\scripts\resolve-source-id.sh" && bash -n "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\scripts\resolve-source-id.sh"`
Expected: `bash -n` 无输出（语法 OK）。

- [ ] **Step 7: 验证（替代 git commit —— 目标目录不在 git）**

运行回归测试（Step 5 已通过）+ 确认 `scripts/resolve-source-id.sh` 与既有脚本风格一致（`grep -c require_python_cmd scripts/resolve-source-id.sh` 输出 ≥ 1）。此任务产物即 Task 4 待同步的两个文件之一。

---

### Task 2: 修改 `SKILL.md`（通用前置检查 + query 第 4 步 + digest 第 1 步）

**Files:**
- Modify: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\SKILL.md`
  - 通用前置检查（第 157-163 行附近，`字段缺失 → 默认 WIKI_LANG=zh` 之后）
  - 工作流 4：query · 第 4 步「综合回答」（第 603-606 行附近）
  - 工作流 7：digest · 第 1 步「搜索相关页面」（第 797-800 行附近）

**Interfaces:**
- Consumes: Task 1 的 `resolve-source-id.sh <wiki_root> <source_page>` JSON 输出（`title`/`documentId`/`previewBase`/`canLink`）。
- Produces: 模型回答时按 `PREVIEW_BASE`（通用前置检查读取的字段）+ `resolve-source-id.sh` 结果生成出处/预览块。Task 3 同步的就是修改后的 SKILL.md。

- [ ] **Step 1: 通用前置检查新增第 5 步**

在 `## 通用前置检查` 中 `WIKI_LANG` 判断（第 4 步）之后追加：

```markdown
5. 读取 `.wiki-schema.md` 的"预览地址"字段为 `PREVIEW_BASE`
   - 如 `预览地址：http://192.168.0.101` → `PREVIEW_BASE=http://192.168.0.101`
   - 字段缺失或为空 → `PREVIEW_BASE=null`（后续工作流无预览链接，只给出处说明）
```

- [ ] **Step 2: query 工作流第 4 步「综合回答」追加出处与预览块**

在「综合回答」现有 bullets（`如果多个素材有不同观点，分别列出并标注来源`）之后追加：

```markdown
   - **附加出处与预览链接**：对回答中实际引用的每个来源页，运行
     `bash ${SKILL_DIR}/scripts/resolve-source-id.sh "<知识库根路径>" "<来源页路径>"`
     解析 `title` / `documentId` / `previewBase` / `canLink` 后，为每条来源按以下格式附加：
       **出处**：{title}（文档ID {documentId}）
       **原文预览**：[打开原文]({previewBase}/#/knowledge/document/detail/{documentId})
     - 仅对回答中实际引用的来源页调用；脚本失败（非 0 退出）则跳过该条，不阻塞回答
     - `previewBase` 为 null → 只给"出处"行，不给链接
     - `documentId` 为空 → "出处"行只写 {title}，不给链接
     - 两者都无 → 保持原有 `[[页面名]]` 引用，不加出处块
```

- [ ] **Step 3: digest 工作流第 1 步「搜索相关页面」追加**

在「列出将要综合的页面（让用户了解报告覆盖范围）」之后追加：

```markdown
   - **附加出处与预览链接**：对将要综合的来源页，用 `resolve-source-id.sh`（同 query 工作流）解析出处说明与预览链接，在报告"相关页面"段落一并列出
```

- [ ] **Step 4: 验证插入点**

Run（在源码仓库）：
```bash
cd "D:\hsl\llm-wiki-skill\llm-wiki-skill-main"
grep -n "PREVIEW_BASE" SKILL.md
grep -n "resolve-source-id.sh" SKILL.md
```
Expected: `PREVIEW_BASE` 出现在通用前置检查第 5 步；`resolve-source-id.sh` 出现在 query 第 4 步与 digest 第 1 步，各 1 处。

---

### Task 3: 同步到已安装技能并校验一致

**Files:**
- Copy: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\scripts\resolve-source-id.sh` → `C:\Users\Administrator\.agents\skills\llm-wiki\scripts\resolve-source-id.sh`
- Copy: `D:\hsl\llm-wiki-skill\llm-wiki-skill-main\SKILL.md` → `C:\Users\Administrator\.agents\skills\llm-wiki\SKILL.md`

**Interfaces:**
- Consumes: Task 1 与 Task 2 的产物。
- Produces: 已安装技能与源仓库两份副本完全一致（安装目录即时生效，供 opencode 会话使用）。

- [ ] **Step 1: 复制脚本**

Run: `cp "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\scripts\resolve-source-id.sh" "C:\Users\Administrator\.agents\skills\llm-wiki\scripts\resolve-source-id.sh" && chmod +x "C:\Users\Administrator\.agents\skills\llm-wiki\scripts\resolve-source-id.sh"`

- [ ] **Step 2: 复制 SKILL.md**

Run: `cp "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\SKILL.md" "C:\Users\Administrator\.agents\skills\llm-wiki\SKILL.md"`

- [ ] **Step 3: 校验两份副本逐文件一致**

Run:
```bash
diff -q "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\SKILL.md" "C:\Users\Administrator\.agents\skills\llm-wiki\SKILL.md" && \
diff -q "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\scripts\resolve-source-id.sh" "C:\Users\Administrator\.agents\skills\llm-wiki\scripts\resolve-source-id.sh" && \
diff -q "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\scripts\shared-config.sh" "C:\Users\Administrator\.agents\skills\llm-wiki\scripts\shared-config.sh" && \
echo "ALL IDENTICAL"
```
Expected: `ALL IDENTICAL`。

- [ ] **Step 4: 在已安装技能上复跑回归（指向源仓库夹具）**

Run: `bash "D:\hsl\llm-wiki-skill\llm-wiki-skill-main\tests\resolve-source-id.regression-1.sh"`
Expected: `PASS: resolve-source-id regression`（脚本逻辑不变，只是换了个安装位置）。

---

### Task 4: 真实知识库端到端验证（含临时配置，随后还原）

**Files:**
- Modify（临时，随后还原）: `D:\hsl\llm-wiki-skill\aistore\.wiki-schema.md`

**Interfaces:**
- Consumes: 已安装的 `resolve-source-id.sh` + 真实库 `D:\hsl\llm-wiki-skill\aistore`。
- Produces: 端到端证明——真实日期标题页能解析出真实 documentId，且临时加 `预览地址` 后 URL 正确。

- [ ] **Step 1: 真实库日期标题页解析（不加预览地址）**

Run: `bash "C:\Users\Administrator\.agents\skills\llm-wiki\scripts\resolve-source-id.sh" "D:\hsl\llm-wiki-skill\aistore" "wiki/sources/2025-09-19-河湖库监测感知方案征求意见函.md"`
Expected: 输出 JSON 中 `"documentId": "2084893088598257665"`（与真实库唯一数字页匹配），`"canLink": false`（当前未配预览地址）。

- [ ] **Step 2: 备份 + 临时添加预览地址**

Run:
```bash
cp "D:\hsl\llm-wiki-skill\aistore\.wiki-schema.md" /tmp/wiki-schema.bak
printf '\n预览地址：http://192.168.0.101\n' >> "D:\hsl\llm-wiki-skill\aistore\.wiki-schema.md"
```

- [ ] **Step 3: 再次解析，确认 canLink 与 URL**

Run: 同 Step 1 命令
Expected: `"canLink": true` 且 `"previewBase": "http://192.168.0.101"`；手工核对拼接 URL `http://192.168.0.101/#/knowledge/document/detail/2084893088598257665`。

- [ ] **Step 4: 还原真实库配置**

Run: `cp /tmp/wiki-schema.bak "D:\hsl\llm-wiki-skill\aistore\.wiki-schema.md" && rm -f /tmp/wiki-schema.bak`
Run（确认还原）：`bash "C:\Users\Administrator\.agents\skills\llm-wiki\scripts\resolve-source-id.sh" "D:\hsl\llm-wiki-skill\aistore" "wiki/sources/2025-09-19-河湖库监测感知方案征求意见函.md"` → `"previewBase": null`。

> 提示：若用户希望保留 `预览地址` 配置，可跳过 Step 4 的还原，仅保留 `预览地址：http://192.168.0.101`（由用户决定）。

---

### Task 5: 提交本计划文档到 opencode 仓库

**Files:**
- Create (committed): `D:\hsl\opencode\docs\superpowers\plans\2026-08-09-llm-wiki-citation-links.md`

**Interfaces:**
- Consumes: 本计划全部任务产物（脚本 + SKILL.md + 双副本同步 + 端到端验证）。
- Produces: 计划文档纳入版本控制，与已批准规范 `docs/superpowers/specs/2026-08-09-llm-wiki-citation-links-design.md` 配套。

- [ ] **Step 1: 提交计划文档**

Run:
```bash
cd "D:\hsl\opencode"
git add docs/superpowers/plans/2026-08-09-llm-wiki-citation-links.md
git commit -m "docs(plan): llm-wiki search citation source info + preview link implementation"
```

- [ ] **Step 2: 汇总验证清单**

逐项确认（列表非空即通过）：
- [ ] `tests/resolve-source-id.regression-1.sh` 通过（`PASS`）
- [ ] 源仓库 `SKILL.md` 含 `PREVIEW_BASE` + `resolve-source-id.sh` 引用
- [ ] 双副本 `diff -q` 为 `ALL IDENTICAL`
- [ ] 真实库解析出 `documentId=2084893088598257665`；临时 `预览地址` 后 `canLink=true`；已还原配置
