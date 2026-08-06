#!/usr/bin/env python3
"""复用上传 .pptx 的 slide layouts 构建新 PPT：按 deck.json 建页填占位符。"""
import json
import os
import sys


def fill_placeholders(slide, placeholders):
    """按 idx 匹配占位符并填入文本。返回成功填充数。"""
    filled = 0
    for item in placeholders:
        idx = item.get("idx")
        text = item.get("text", "")
        if text == "":
            continue
        for shape in slide.shapes:
            if not shape.is_placeholder:
                continue
            if shape.placeholder_format.idx == idx:
                shape.text = text
                filled += 1
                break
    return filled


def main() -> None:
    if len(sys.argv) < 4:
        print("usage: build.py <style.pptx> <deck.json> <out.pptx>", file=sys.stderr)
        sys.exit(1)
    from pptx import Presentation

    style_path, deck_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(deck_path, encoding="utf-8") as f:
        deck = json.load(f)

    prs = Presentation(style_path)
    slides = 0
    for page in deck.get("layouts", []):
        layout_index = page.get("layoutIndex")
        if not isinstance(layout_index, int) or layout_index < 0 or layout_index >= len(prs.slide_layouts):
            raise ValueError(f"invalid layoutIndex: {layout_index}")
        layout = prs.slide_layouts[layout_index]
        slide = prs.slides.add_slide(layout)
        fill_placeholders(slide, page.get("placeholders", []))
        slides += 1

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    prs.save(out_path)
    print(json.dumps({"ok": True, "slides": slides}, ensure_ascii=False))


if __name__ == "__main__":
    main()
