#!/usr/bin/env python3
"""LibreOffice 渲染 PPT 首屏为 PNG 封面。

用法:
  render_cover.py <style.pptx> <out.png>

依赖: libreoffice-impress（soffice）+ poppler-utils（pdftoppm）。
流程: soffice --headless --convert-to pdf → pdftoppm 取 PDF 第一页 → PNG（1920 宽）。
失败: 命令非零退出 / cover.png 不存在/空 → 非零返回，错误写 stderr。
"""
import argparse
import glob
import os
import subprocess
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_WIDTH = 1920


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx", help="输入 style.pptx")
    ap.add_argument("out", help="输出 cover.png 路径")
    ap.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    ap.add_argument("--workdir", default=None, help="中间产物目录（默认临时目录，用完删除）")
    args = ap.parse_args()

    import shutil
    import tempfile

    workdir = args.workdir or tempfile.mkdtemp(prefix="ppt-cover-")
    base = os.path.splitext(os.path.basename(args.pptx))[0]

    try:
        # 1) soffice 转 PDF
        r1 = subprocess.run(
            ["soffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", workdir, args.pptx],
            capture_output=True, text=True, timeout=180,
        )
        pdf = os.path.join(workdir, base + ".pdf")
        if r1.returncode != 0 or not os.path.exists(pdf) or os.path.getsize(pdf) == 0:
            print(f"[cover] soffice failed: {r1.stderr}", file=sys.stderr)
            sys.exit(1)

        # 2) pdftoppm 取第一页 PNG
        page_prefix = os.path.join(workdir, "page")
        r2 = subprocess.run(
            ["pdftoppm", "-f", "1", "-l", "1", "-png", "-scale-to", str(args.width), pdf, page_prefix],
            capture_output=True, text=True, timeout=120,
        )
        if r2.returncode != 0:
            print(f"[cover] pdftoppm failed: {r2.stderr}", file=sys.stderr)
            sys.exit(2)

        pages = sorted(glob.glob(page_prefix + "*.png"))
        if not pages:
            print("[cover] pdftoppm produced no png", file=sys.stderr)
            sys.exit(3)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        shutil.move(pages[0], args.out)
        if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
            print("[cover] cover.png empty", file=sys.stderr)
            sys.exit(4)
        print(f"[cover] saved {args.out} {os.path.getsize(args.out)} bytes")
    finally:
        if args.workdir is None:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
