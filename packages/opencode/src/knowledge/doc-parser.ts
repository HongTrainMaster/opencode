import { Effect } from "effect"
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

async function extractDocxText(buf: Uint8Array): Promise<string> {
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

export function parseDocument(args: { format: string; fileContent?: string }): Effect.Effect<ParsedDocument, Error> {
  return Effect.tryPromise({
    try: async () => {
      const format = (args.format ?? "").toLowerCase().replace(/^\./, "")
      const content = args.fileContent ?? ""
      if (!content) return { text: "" }
      if (["txt", "md", "markdown", "text"].includes(format)) {
        return { text: decodeText(content) }
      }
      if (format === "pdf") {
        return { text: extractPdfText(decodeBase64(content)) }
      }
      if (format === "docx") {
        return { text: await extractDocxText(decodeBase64(content)) }
      }
      // legacy .doc / xlsx / pptx / images: no text extraction in MVP
      return { text: "" }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}
