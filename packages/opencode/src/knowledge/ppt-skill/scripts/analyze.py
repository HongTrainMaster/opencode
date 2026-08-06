#!/usr/bin/env python3
"""读取 .pptx 的 slide layouts 目录与原始 slides 设计目录（含可编辑文本形状），stdout 输出 JSON。

输出结构：
{
  "layouts": [ {"index", "name", "placeholders": [{"idx","type","name"}]} ],
  "slides": [
    {
      "slideIndex": 0,
      "layout": "DEFAULT",
      "shapes": [
        {"name": "Text 0", "type": "AUTO_SHAPE", "isPlaceholder": false, "text": "当前文本"},
        {"name": "标题 1", "type": "PLACEHOLDER", "isPlaceholder": true, "placeholderIdx": 0, "text": "当前标题"}
      ]
    }
  ]
}
模型据此用 slideIndex + shape 名称/占位符 idx 定位要替换的文本，保证新页保留原设计。
"""
import json
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# python-pptx MSO_SHAPE_TYPE 枚举（Python-pptx 1.0.2）
# 13=PICTURE, 14=PLACEHOLDER, 17=TABLE, 19=CHART ... 以 python-pptx 实际值为准
SHAPE_TYPE_NAMES = {
    1: "AUTO_SHAPE", 2: "CALL_OUT", 3: "CHART", 4: "COMMENT", 5: "FREEFORM",
    6: "GROUP", 7: "LINE", 8: "LINK", 9: "MEDIA", 10: "OLE", 12: "TEXT_BOX",
    13: "PICTURE", 14: "PLACEHOLDER", 17: "TABLE", 18: "SMART_ART", 19: "CHART",
    20: "VIDEO", 21: "INK", 22: "CONTENT_APP", 23: "DIAGRAM", 24: "SCRIPT_BUTTON",
}


def shape_type_name(shape) -> str:
    try:
        # shape.shape_type 是 MSO_SHAPE_TYPE 枚举，int() 取其数值；映射失败回落 str() 的 "PICTURE (13)" 形式
        mapped = SHAPE_TYPE_NAMES.get(int(shape.shape_type))
        if mapped:
            return mapped
        s = str(shape.shape_type)
        # 兜底：从 "PICTURE (13)" 提取类型名
        if s.startswith("PICTURE"):
            return "PICTURE"
        if s.startswith("TABLE"):
            return "TABLE"
        return s
    except Exception:
        return "UNKNOWN"


def shape_text(shape) -> str:
    """尽力读取形状文本（含占位符/文本框/自选图形），读取失败返回空串。"""
    try:
        if shape.has_text_frame:
            return shape.text_frame.text.strip()
    except Exception:
        pass
    try:
        if shape.has_table:
            rows = []
            for row in shape.table.rows:
                cells = [c.text.strip() for c in row.cells]
                rows.append("|".join(cells))
            return "\n".join(rows)[:200]
    except Exception:
        pass
    return ""


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: analyze.py <file.pptx>", file=sys.stderr)
        sys.exit(1)
    from pptx import Presentation

    prs = Presentation(sys.argv[1])
    layouts = []
    for i, layout in enumerate(prs.slide_layouts):
        placeholders = []
        for ph in layout.placeholders:
            placeholders.append({
                "idx": ph.placeholder_format.idx,
                "type": str(ph.placeholder_format.type),
                "name": ph.name,
            })
        layouts.append({"index": i, "name": layout.name, "placeholders": placeholders})

    slides = []
    for i, slide in enumerate(prs.slides):
        shapes = []
        for s in slide.shapes:
            item = {
                "name": s.name,
                "type": shape_type_name(s),
                "isPlaceholder": bool(s.is_placeholder),
            }
            if s.is_placeholder:
                try:
                    item["placeholderIdx"] = s.placeholder_format.idx
                except Exception:
                    pass
            # PICTURE 形状补充尺寸（英寸），模型据此判断插图幅面
            if str(s.shape_type) == "PICTURE (13)":
                try:
                    from pptx.util import Emu
                    item["widthIn"] = round(Emu(s.width).inches, 2) if s.width else None
                    item["heightIn"] = round(Emu(s.height).inches, 2) if s.height else None
                except Exception:
                    pass
            text = shape_text(s)
            if text:
                item["text"] = text[:200]
            shapes.append(item)
        slides.append({
            "slideIndex": i,
            "layout": slide.slide_layout.name if slide.slide_layout is not None else "",
            "shapes": shapes,
        })

    print(json.dumps({"layouts": layouts, "slides": slides}, ensure_ascii=False))


if __name__ == "__main__":
    main()
