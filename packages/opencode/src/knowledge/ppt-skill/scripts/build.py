#!/usr/bin/env python3
"""复用上传 .pptx 的原始页设计构建新 PPT：按 deck.json 建页填文本、生成插图。

deck.json 结构：
{
  "slides": [
    {
      "slideIndex": 0,              # 复用模板第 0 张原始页的设计（XML 级复制，保留图片/形状/背景）
      "texts": {                    # 按 shape 名称 → 新文本（name 与 analyze.py 输出一致）
        "标题 1": "无人机技术培训",
        "Text 0": "副标题内容"
      },
      "placeholders": [             # 兼容旧版：按 placeholder idx 填
        {"idx": 0, "text": "..."}
      ],
      "images": {                   # 插图：shape 名称 → 生成图片的提示词（该 shape 须为模板 PICTURE）
        "Image 0": "A drone flying over a training ground, professional photography"
      }
    }
  ],
  "discardTemplateSlides": true    # 默认 true：模板原始页仅作设计来源，生成完成后删除（只保留新页）
}

images 处理：对每个 (shapeName, prompt)，调用同目录 generate_image.py 生成 PNG，
并替换该 slide 中同名的 PICTURE 形状（保留原位置/尺寸）。图片生成失败不影响文本填充，
仅记 warning（产物仍生成，插图保持模板原图）。

兼容：若页面项只有 layoutIndex（旧格式），回退为 add_slide(layout) 追加。
"""
import copy
import json
import os
import subprocess
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
IMAGE_GEN_SCRIPT = os.path.join(SKILL_DIR, "generate_image.py")
WORK_DIR = os.environ.get("PPT_WORK_DIR", os.getcwd())

# --- 进度上报（写 workdir/output/progress.json，供轮询读取）---
_progress = {"pagesDone": 0, "imagesDone": 0, "currentImage": ""}


def write_progress(payload: dict) -> None:
    """把进度 JSON 写入 workdir 下 output/progress.json（尽力而为）。"""
    try:
        out_dir = os.path.join(WORK_DIR, "output")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "progress.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception:
        pass


def emit_progress(stage: str = "BUILDING", **extra) -> None:
    """合并当前计数 + 额外字段后写盘。"""
    data = {"stage": stage}
    data.update(_progress)
    data.update(extra)
    write_progress(data)


def _set_shape_text(shape, text: str) -> bool:
    """尽力设置形状文本；占位符/文本框/自选图形均可。"""
    try:
        if shape.has_text_frame:
            tf = shape.text_frame
            if tf.paragraphs:
                first = tf.paragraphs[0]
                for r in list(first.runs)[1:]:
                    r._r.getparent().remove(r._r)
                if first.runs:
                    first.runs[0].text = text
                else:
                    first.add_run().text = text
                for p in tf.paragraphs[1:]:
                    p._p.getparent().remove(p._p)
            else:
                tf.text = text
            return True
    except Exception:
        pass
    return False


def _replace_slide_texts(slide, texts: dict, placeholders: list) -> int:
    """按名称替换文本 + 按占位符 idx 填文本。返回成功替换数。"""
    filled = 0
    for shape in slide.shapes:
        name = shape.name
        if name in texts:
            new_text = str(texts[name])
            if new_text and _set_shape_text(shape, new_text):
                filled += 1
    for item in placeholders:
        idx = item.get("idx")
        text = str(item.get("text", ""))
        if text == "":
            continue
        for shape in slide.shapes:
            if not shape.is_placeholder:
                continue
            try:
                if shape.placeholder_format.idx == idx:
                    if _set_shape_text(shape, text):
                        filled += 1
                    break
            except Exception:
                continue
    return filled


def _fit_image_to_box(src_png: str, width_emu: int, height_emu: int) -> str:
    """按目标 box 宽高比 cover 裁剪生成图，输出适配后的 PNG（不变形、精确填充）。

    python-pptx add_picture 保持图片原始比例，512x512 方形图放进宽幅/窄幅 box 会溢出或留白。
    这里用 PIL 中心裁剪到目标比例后保存，保证 add_picture(指定 w/h) 精确填满。
    """
    try:
        from PIL import Image
        from pptx.util import Emu

        target_w = Emu(width_emu).inches
        target_h = Emu(height_emu).inches
        if target_w <= 0 or target_h <= 0:
            return src_png
        ratio = target_w / target_h  # 目标宽高比

        img = Image.open(src_png)
        iw, ih = img.size
        i_ratio = iw / ih
        # cover 裁剪：缩放后中心裁到目标比例
        if i_ratio > ratio:
            # 图更宽 → 裁左右
            new_w = int(ih * ratio)
            left = (iw - new_w) // 2
            img = img.crop((left, 0, left + new_w, ih))
        else:
            # 图更高 → 裁上下
            new_h = int(iw / ratio)
            top = (ih - new_h) // 2
            img = img.crop((0, top, iw, top + new_h))
        fit_path = src_png.replace(".png", "-fit.png")
        img.save(fit_path)
        return fit_path
    except Exception:
        return src_png  # 无 PIL 或失败则用原图（add_picture 兜底）


def _is_picture_shape(shape) -> bool:
    """判断形状是否为图片：优先按 python-pptx 枚举值 13(PICTURE)，兜底检查 XML 是否含 a:blip。"""
    try:
        if int(shape.shape_type) == 13:
            return True
    except Exception:
        pass
    try:
        return "a:blip" in shape._element.xml
    except Exception:
        return False


def _replace_slide_images(slide, images: dict, page_index: int) -> int:
    """按名称生成图片并替换 slide 中的 PICTURE 形状（保留位置/尺寸）。返回替换成功数。"""
    replaced = 0
    for shape in slide.shapes:
        name = shape.name
        prompt = images.get(name)
        if not prompt:
            continue
        # 仅处理图片类形状（枚举 13 或 XML 含 blip）
        if not _is_picture_shape(shape):
            print(f"[img] 跳过非图片形状 '{name}' (type={shape.shape_type})", flush=True)
            continue
        out_png = os.path.join(WORK_DIR, f".ppt-images/page{page_index}-{name}.png")
        # 生成图片前：记录当前图片提示词（图片 40-60s，让前端看到"正在生成哪张图"）
        _progress["currentImage"] = prompt
        emit_progress()
        # 调用同目录 generate_image.py 生成
        r = subprocess.run(
            [sys.executable, IMAGE_GEN_SCRIPT, prompt, out_png],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=600,
        )
        if r.returncode != 0 or not os.path.exists(out_png):
            print(f"[img] 生成失败 '{name}': {r.stderr[-300:] if r.stderr else 'no stderr'}", flush=True)
            _progress["currentImage"] = ""
            emit_progress()
            continue
        # 替换：记录原位置/尺寸，删除原图，插入新图
        try:
            left, top = shape.left, shape.top
            width, height = shape.width, shape.height
            shape._element.getparent().remove(shape._element)
            # 生成图是 512x512 方形，目标区域可能是宽幅/窄幅。
            # 用 PIL 按目标宽高比 cover 裁剪，保证精确填满且不变形。
            final_png = out_png
            if os.path.exists(out_png):
                final_png = _fit_image_to_box(out_png, width, height)
            slide.shapes.add_picture(final_png, left, top, width, height)
            replaced += 1
            _progress["imagesDone"] += 1
            _progress["currentImage"] = ""
            emit_progress()
            print(f"[img] 替换完成 '{name}' -> {final_png}", flush=True)
        except Exception as e:
            print(f"[img] 替换失败 '{name}': {e}", flush=True)
    return replaced


def _duplicate_slide(prs, src_slide):
    """XML 级复制模板原始 slide：保留所有 shapes（图片/形状/背景）+ 图片关系。"""
    new_slide = prs.slides.add_slide(src_slide.slide_layout)
    for shp in list(new_slide.shapes):
        shp._element.getparent().remove(shp._element)
    sp_tree = new_slide.shapes._spTree
    for shape in src_slide.shapes:
        sp_tree.append(copy.deepcopy(shape._element))
    for rel_id, rel in src_slide.part.rels.items():
        if "image" in rel.reltype or "media" in rel.reltype:
            try:
                new_slide.part.rels.get_or_add(rel.reltype, rel.target_part)
            except Exception:
                pass
    src_bg = src_slide._element.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}bg")
    if src_bg is not None:
        existing = new_slide._element.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}bg")
        if existing is not None:
            existing.getparent().remove(existing)
        new_slide._element.insert(0, copy.deepcopy(src_bg))
    return new_slide


def _remove_template_slides(prs, keep_from_index: int):
    """删除模板原始页（keep_from_index 之前的全部页），仅保留其后新生成的页。

    python-pptx 无公开删除 API，通过操作 XML 的 sldIdLst 并 drop 对应关系实现。
    """
    from pptx.oxml.ns import qn

    xml_slides = prs.slides._sldIdLst
    sld_ids = list(xml_slides)
    # 逆序删除 keep_from_index 之前的页，避免索引漂移
    for sldId in sld_ids[keep_from_index::-1]:
        rId = sldId.get(qn("r:id"))
        try:
            prs.part.drop_rel(rId)
        except Exception:
            pass
        xml_slides.remove(sldId)


def main() -> None:
    if len(sys.argv) < 4:
        print("usage: build.py <style.pptx> <deck.json> <out.pptx>", file=sys.stderr)
        sys.exit(1)
    from pptx import Presentation

    style_path, deck_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(deck_path, encoding="utf-8") as f:
        deck = json.load(f)

    prs = Presentation(style_path)
    template_count = len(prs.slides)
    slides_count = 0
    filled_total = 0
    image_total = 0

    pages = deck.get("slides", deck.get("layouts", []))
    total_pages = len(pages)
    images_total = sum(len((p.get("images", {}) or {})) for p in pages)
    # 阶段 B：构建启动（总页数 = deck slides 数，插图总数 = 所有页 images 数）
    write_progress({
        "stage": "BUILDING", "totalPages": total_pages, "pagesDone": 0,
        "imagesTotal": images_total, "imagesDone": 0, "currentImage": "",
    })

    for page_index, page in enumerate(pages):
        slide_index = page.get("slideIndex")
        texts = page.get("texts", {}) or {}
        placeholders = page.get("placeholders", []) or []
        images = page.get("images", {}) or {}
        layout_index = page.get("layoutIndex")

        if isinstance(slide_index, int) and 0 <= slide_index < template_count:
            src = prs.slides[slide_index]
            new_slide = _duplicate_slide(prs, src)
        elif isinstance(layout_index, int) and 0 <= layout_index < len(prs.slide_layouts):
            new_slide = prs.slides.add_slide(prs.slide_layouts[layout_index])
        else:
            raise ValueError(f"invalid page: {page}")

        filled_total += _replace_slide_texts(new_slide, texts, placeholders)
        image_total += _replace_slide_images(new_slide, images, page_index)
        slides_count += 1
        # 阶段 C：每构建完一页更新页数进度
        _progress["pagesDone"] = slides_count
        emit_progress(totalPages=total_pages, imagesTotal=images_total)

    # 关键：模板原始页仅作设计来源，生成完成后删除，产物只保留新生成的页
    if deck.get("discardTemplateSlides", True):
        _remove_template_slides(prs, template_count - 1)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    prs.save(out_path)
    # 阶段 D：全部完成
    write_progress({
        "stage": "DONE", "totalPages": total_pages, "pagesDone": slides_count,
        "imagesTotal": images_total, "imagesDone": _progress["imagesDone"], "currentImage": "",
    })
    print(json.dumps({"ok": True, "slides": slides_count, "filled": filled_total, "images": image_total}, ensure_ascii=False))


if __name__ == "__main__":
    main()
