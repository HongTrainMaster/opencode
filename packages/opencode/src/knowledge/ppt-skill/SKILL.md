---
name: ppt-gen
description: 上传 PPT 风格参考生成新 PPT。分析版式目录→按提示词生成内容→复用版式构建 .pptx。
---

# PPT 生成（版式复用）

## 目标
用户上传一份 .pptx 作为**风格参考**（仅复用其 slide layouts/母版/配色），结合提示词生成一份新的 .pptx。

## 输入
- `style.pptx`：工作目录内用户上传的风格参考 PPT。
- 用户提示词：本次会话消息中给出（内容/主题/页数倾向）。

## 流程（严格按序执行）
1. 运行 `python {SKILL_DIR}/scripts/analyze.py style.pptx`，读取输出的 layouts 目录。
   - 每个 layout 有 `index`、`name`、`placeholders`（含 `idx`/`type`/`name`）。
2. 结合提示词 + layouts 目录，编写 `deck.json`：
   - 结构：`{"layouts": [{"layoutIndex": i, "placeholders": [{"idx": N, "text": "..."}]}]}`
   - **只引用 analyze.py 输出的真实存在的 `index`**；每个 placeholder 的 `idx` 必须存在于该 layout 的 placeholders。
   - 一页内容对应一个 layout 项：封面页、目录页、过渡页、内容页、结束页尽量齐全；页数按提示词需要。
3. 运行 `python {SKILL_DIR}/scripts/build.py style.pptx deck.json output/result.pptx` 构建。
4. 确认 `output/result.pptx` 存在且非空（构建失败需修正 deck.json 重试）。

## 规则
- 不要修改 `style.pptx` 本身；只在构建时复用其 layouts。
- 文本内容按提示词重新生成；不提取 style.pptx 的正文。
- 输出必须是 `output/result.pptx` 这个固定路径。
