# 默认本地搜索提示词设计

## 目标

在所有模型系统提示词（prompt）中增加引导说明，让 AI 在没有明确指定时优先使用本地搜索工具（Grep/Glob/Read），而不是默认使用 WebSearch/WebFetch。

## 背景

OpenCode 是一个主要面向本地代码仓库的 AI 编码助手。当前各模型的 system prompt 中，关于搜索行为的指引是空白的——AI 可能在用户未要求网络搜索时自行调用 WebSearch/WebFetch，这既浪费 token 也不符合用户的本地优先预期。

## 改动范围

修改以下 9 个 prompt 文件：

| 文件 | 对应模型 |
|------|---------|
| `packages/opencode/src/session/prompt/anthropic.txt` | Claude |
| `packages/opencode/src/session/prompt/default.txt` | 默认回退 |
| `packages/opencode/src/session/prompt/beast.txt` | GPT-4/o1/o3 |
| `packages/opencode/src/session/prompt/gpt.txt` | GPT（非 Codex） |
| `packages/opencode/src/session/prompt/gemini.txt` | Gemini |
| `packages/opencode/src/session/prompt/kimi.txt` | Kimi |
| `packages/opencode/src/session/prompt/meta.txt` | Meta Muse Spark |
| `packages/opencode/src/session/prompt/codex.txt` | GPT Codex |
| `packages/opencode/src/session/prompt/trinity.txt` | Trinity |

**不修改的文件：**
- `build-switch.txt` — 构建切换用，非模型行为 prompt
- `plan-mode.txt` — 计划模式系统提示
- `plan-reminder-anthropic.txt` — 计划模式提醒
- `plan.txt` — 计划模式系统提示
- `copilot-gpt-5.txt` — Copilot 集成专用，非独立模型 prompt

## 改动内容

在每个文件的合适位置插入以下引导文字（中文）：

> 本项目主要基于本地文件进行搜索。当用户未明确要求获取网络信息时，应优先使用本地搜索工具（如 Grep、Glob、Read），而非 WebSearch 或 WebFetch。

### 插入位置选择

根据各文件结构决定：
- **有 "Tool usage policy" 节的文件**：放在该节末尾或下方
- **有 "Doing tasks" 节的文件**：放在该节的行为指引中
- **无明确分节的文件**：放在 "Tone and style" 附近，作为基本原则

### 措辞说明

- 使用 **"优先使用"** 而非 **"必须使用"** — 保留 AI 在确实需要网络信息时使用 WebSearch 的灵活性
- 使用中文 — 与用户使用的语言一致，且这是面向中文用户的修改
- 明确列举本地搜索工具（Grep、Glob、Read）— 减少歧义
- 与原有 "IMPORTANT" 指令风格一致

## 验证方式

1. 逐个读取修改后的文件，确认语法和格式正确
2. 检查所有文件均被修改，无遗漏
