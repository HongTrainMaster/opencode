---
name: ppt-gen
description: 上传 PPT 风格参考生成新 PPT。分析模板原始页设计目录→按提示词生成内容→复用模板页设计构建 .pptx（自动删除模板多余页，可对模板图片位置生成 AI 插图）。
---

# PPT 生成（模板页设计复用 + AI 插图）

## 目标
用户上传一份 .pptx 作为**风格参考模板**（复用其原始页面的设计：图片/形状/背景/母版配色），结合提示词生成一份新的 .pptx。模板中的图片位置可**按页面内容生成 AI 插图**替换。

## 输入
- `style.pptx`：工作目录内用户上传的风格参考 PPT。
- 用户提示词：本次会话消息中给出（内容/主题/页数倾向）。

## 流程（严格按序执行）

### 1. 分析模板
运行 `python {SKILL_DIR}/scripts/analyze.py style.pptx`，读取输出 JSON：
- `slides`：模板原始页目录（优先使用）。每页含 `slideIndex`、`layout`、`shapes` 数组：
  - `name`：形状名称（替换文本/图片时用此名称定位）。
  - `type`：形状类型（AUTO_SHAPE/TEXT_BOX/PLACEHOLDER/**PICTURE**/TABLE...）。
  - `widthIn`/`heightIn`：PICTURE 形状的尺寸（英寸）。
  - `isPlaceholder` + `placeholderIdx`、`text`：文本信息。

先浏览 `slides` 目录，识别模板中适合各类用途的页（封面、目录、过渡、内容、结尾），**记录每页的 slideIndex、要替换文本的 shape 名称、以及 PICTURE 图片形状的名称**。

### 2. 编写 deck.json
```json
{
  "slides": [
    {
      "slideIndex": 0,
      "texts": {
        "Text 0": "无人机技术培训",
        "Text 6": "广东省北江流域管理局",
        "Text 5": "2026年8月"
      },
      "images": {
        "Image 0": "A professional drone hovering above a training field, cinematic lighting, detailed"
      }
    },
    {
      "slideIndex": 5,
      "texts": {
        "Text 3": "目录",
        "Text 6": "一、无人机基础概述",
        "Text 9": "二、无人机系统组成"
      },
      "images": {
        "图片 93195": "Futuristic drone technology concept, blue tones, high detail"
      }
    }
  ]
}
```
规则：
- **每页用 `slideIndex` 引用模板原始页**（值是 analyze.py 输出的真实 slideIndex），`texts` 键为**该页存在的 shape 名称**，值为新文本。
- **`images` 可选**：键为**该页 PICTURE 形状的名称**（analyze.py 输出 type=PICTURE 的 shape），值为**该页主题的英文插图提示词**。build.py 会用本地 SSD-1B 生成图片替换该位置（保留原尺寸）。
  - 插图提示词建议：描述主体 + 场景 + 风格（如 "professional photography"、"futuristic"、"cinematic lighting"、"blue tones"），英文效果更好。
  - 只对**内容相关的 PICTURE** 生成插图；装饰性小图标/logo 可保留原图（不写进 images）。
- 一页内容对应一个 slide 项：封面页、目录页、过渡页、内容页、结尾页尽量齐全；页数按提示词需要。
- 若某页实在无法用 slideIndex 表达（模板无合适页），可用 `{"layoutIndex": i, "placeholders": [...]}` 兜底（不保留设计，尽量不用）。

### 3. 构建
运行 `python {SKILL_DIR}/scripts/build.py style.pptx deck.json output/result.pptx` 构建。
- build.py 会**复制模板原始页的设计**（图片/形状/背景），替换 `texts` 指定的文本，对 `images` 指定的 PICTURE 形状调用本地文生图生成新图替换，然后**删除模板所有原始页**，产物只保留新生成的页。
- 每张插图生成约 40-60 秒；多页插图会串行生成，耐心等待。图片生成失败不阻断（保留模板原图）。

### 4. 校验
确认 `output/result.pptx` 存在且非空，页数与 deck.json 的 slides 数一致（构建失败需修正 deck.json 重试）。

## 规则
- 不要修改 `style.pptx` 本身；只在构建时复制其页设计。
- 文本内容按提示词重新生成；不要保留模板示例文字。
- 输出必须是 `output/result.pptx` 这个固定路径。
- 插图用本地模型生成，不依赖外网；提示词用英文以获得更稳定效果。
