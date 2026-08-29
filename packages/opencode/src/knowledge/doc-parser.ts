import { Effect } from "effect"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { inflateSync } from "node:zlib"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"

export interface ParsedDocument {
  text: string
}

function decodeBase64(content: string): Uint8Array {
  return Buffer.from(content, "base64")
}

function decodeText(content: string): string {
  return Buffer.from(content, "base64").toString("utf-8")
}

// --- PDF text extraction (best-effort for simple PDFs) ---

export function extractPdfText(buf: Uint8Array): string {
  const content = Buffer.from(buf)
  const str = content.toString("latin1")
  const chunks: string[] = []
  const streamRe = /stream\r?\n(.*?)endstream/gs
  let m: RegExpExecArray | null
  while ((m = streamRe.exec(str)) !== null) {
    const raw = m[1]!.replace(/\r?\n$/, "")
    const start = str.lastIndexOf("<<", m.index)
    const dict = start === -1 ? "" : str.slice(start, m.index)
    let data: Buffer
    if (dict.includes("/FlateDecode")) {
      try {
        data = inflateSync(Buffer.from(raw, "latin1"))
      } catch {
        continue
      }
    } else {
      data = Buffer.from(raw, "latin1")
    }
    const text = extractPdfTextOperators(data.toString("utf-8"))
    if (text) chunks.push(text)
  }
  return chunks
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function extractPdfTextOperators(str: string): string {
  const out: string[] = []
  const re = /\(((?:[^()\\]|\\.)*)\)\s*Tj|\[((?:[^[\]\\]|\\.)*)\]\s*TJ/gs
  let m: RegExpExecArray | null
  while ((m = re.exec(str)) !== null) {
    if (m[1] !== undefined) {
      out.push(m[1].replace(/\\([()\\])/g, "$1"))
    } else if (m[2] !== undefined) {
      const parts = m[2].match(/\(((?:[^()\\]|\\.)*)\)/g)
      if (parts) out.push(parts.map((p) => p.slice(1, -1).replace(/\\([()\\])/g, "$1")).join(""))
    }
  }
  return out.join("")
}

// --- DOCX (zip of XML) ---

function stripXml(xml: string): string {
  return xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<w:p[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export async function extractDocxText(buf: Uint8Array): Promise<string> {
  const blob = new Blob([new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)])
  const reader = new ZipReader(new BlobReader(blob))
  try {
    const entries = await reader.getEntries()
    const doc = entries.find((e) => e.filename === "word/document.xml")
    if (!doc) return ""
    const xml = await doc.getData!(new TextWriter())
    return stripXml(xml)
  } finally {
    await reader.close()
  }
}

// --- entrypoint ---

const execFileAsync = promisify(execFile)

/**
 * OCR 兜底：当内置解析（txt/pdf/docx 提取）拿不到文本时，用 tesseract -l chi_sim
 * 识别图片或扫描版文档。可配置：
 *   - TESSERACT_CMD    : tesseract 可执行路径（默认 "tesseract"）
 *   - OCR_SOFFICE_CMD  : libreoffice 可执行路径（默认 "soffice"，doc/xlsx/pptx 先转 pdf）
 *
 * 任一外部命令缺失或失败 → 静默返回 ""（保持原 SKIPPED 语义，不抛错打断入库）。
 */
async function extractTextViaOcr(content: string, format: string): Promise<string> {
  const tesseract = process.env.TESSERACT_CMD ?? "tesseract"
  const dir = await mkdtemp(join(tmpdir(), "opencode-ocr-"))
  try {
    // 1. 把 base64 原始字节落盘（格式决定扩展名）
    const rawExt = format || "png"
    const inputPath = join(dir, `input.${rawExt}`)
    await writeFile(inputPath, Buffer.from(content, "base64"))

    // 2. doc/docx/xlsx/pptx：soffice 转 pdf，再 pdftoppm 渲染成图
    let ocrPath = inputPath
    const officeFormats = ["doc", "docx", "xlsx", "pptx"]
    if (officeFormats.includes(rawExt)) {
      try {
        const soffice = process.env.OCR_SOFFICE_CMD ?? "soffice"
        await execFileAsync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", dir, inputPath], {
          timeout: 120_000,
        })
        const pdfPath = join(dir, "input.pdf")
        await execFileAsync("pdftoppm", ["-png", "-r", "200", pdfPath, join(dir, "page")], {
          timeout: 120_000,
        })
        ocrPath = join(dir, "page-1.png")
      } catch {
        return ""
      }
    } else if (rawExt === "pdf") {
      // 3. 扫描版 PDF：pdftoppm 渲染各页
      try {
        await execFileAsync("pdftoppm", ["-png", "-r", "200", inputPath, join(dir, "page")], {
          timeout: 120_000,
        })
        ocrPath = join(dir, "page-1.png")
      } catch {
        return ""
      }
    }

    // 4. tesseract OCR（图片 / 已渲染的 pdf 页）
    try {
      const { stdout } = await execFileAsync(tesseract, [ocrPath, "stdout", "-l", "chi_sim"], {
        timeout: 120_000,
      })
      return stdout.trim()
    } catch {
      return ""
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function parseDocument(args: { format: string; fileContent?: string }): Effect.Effect<ParsedDocument, Error> {
  return Effect.tryPromise({
    try: async () => {
      const format = (args.format ?? "").toLowerCase().replace(/^\./, "")
      const content = args.fileContent ?? ""
      if (!content) return { text: "" }
      let text = ""
      if (["txt", "md", "markdown", "text"].includes(format)) {
        text = decodeText(content)
      } else if (format === "pdf") {
        text = extractPdfText(decodeBase64(content))
      } else if (format === "docx") {
        text = await extractDocxText(decodeBase64(content))
      }
      // OCR 兜底：内置解析拿不到文本（扫描件/不支持格式）时调 tesseract -l chi_sim
      if (!text) {
        text = await extractTextViaOcr(content, format)
      }
      return { text }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}
