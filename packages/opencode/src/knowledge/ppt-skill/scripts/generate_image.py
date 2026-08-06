#!/usr/bin/env python3
"""SSD-1B 本地文生图：根据提示词生成 PNG 插图，供 PPT 构建替换模板图片。

用法:
  generate_image.py <prompt> <out.png> [--width 512] [--height 512] [--steps 20] [--model PATH]

模型路径默认 /home/bjglj/models/SSD-1B（可用 --model 或环境变量 SSD_MODEL_DIR 覆盖）。
显存受限时自动启用 sequential CPU offload（逐层卸载，显存占用 ~2.5GB）。
"""
import argparse
import os
import sys
import time

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_MODEL = "/home/bjglj/models/SSD-1B"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", help="英文或中文提示词")
    ap.add_argument("out", help="输出 PNG 路径")
    ap.add_argument("--width", type=int, default=512)
    ap.add_argument("--height", type=int, default=512)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--model", default=os.environ.get("SSD_MODEL_DIR", DEFAULT_MODEL))
    args = ap.parse_args()

    import torch
    from diffusers import StableDiffusionXLPipeline

    t0 = time.time()
    print(f"[img] 加载模型 {args.model} ...", flush=True)
    pipe = StableDiffusionXLPipeline.from_pretrained(
        args.model,
        torch_dtype=torch.float16,
        use_safetensors=True,
    )
    pipe.enable_sequential_cpu_offload()
    print(f"[img] 模型加载完成 {round(time.time()-t0, 1)}s", flush=True)

    t1 = time.time()
    image = pipe(
        args.prompt,
        num_inference_steps=args.steps,
        guidance_scale=7.5,
        width=args.width,
        height=args.height,
    ).images[0]
    print(f"[img] 生成完成 {round(time.time()-t1, 1)}s", flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    image.save(args.out)
    print(f"[img] saved {args.out} {os.path.getsize(args.out)} bytes {image.size}", flush=True)


if __name__ == "__main__":
    main()
