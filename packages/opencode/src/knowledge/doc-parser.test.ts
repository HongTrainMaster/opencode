import { describe, expect, it } from "bun:test"
import { deflateSync } from "node:zlib"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import { Effect } from "effect"
import { extractPdfText, parseDocument } from "./doc-parser"

function makeMinimalPdf(texts: string[]): Uint8Array {
  let content = ""
  for (const t of texts) {
    content += `BT /F1 12 Tf 72 720 Td (${t}) Tj ET\n`
  }
  const deflated = deflateSync(Buffer.from(content, "utf-8"))
  const head = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    "endobj",
    "4 0 obj",
    `<< /Length ${deflated.length} /Filter /FlateDecode >>`,
    "stream",
  ].join("\n")
  const body = "\n" + deflated.toString("latin1") + "\nendstream\nendobj\n"
  const tail = "trailer\n<< /Root 1 0 R >>\n%%EOF\n"
  return Buffer.from(head + body + tail, "latin1")
}

async function makeDocx(text: string): Promise<Uint8Array> {
  const blobWriter = new BlobWriter("application/zip")
  const zip = new ZipWriter(blobWriter)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`
  await zip.add("word/document.xml", new TextReader(xml))
  await zip.add(
    "[Content_Types].xml",
    new TextReader(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
  )
  const blob = await zip.close()
  return new Uint8Array(await blob.arrayBuffer())
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("doc-parser", () => {
  it("parses txt from base64", async () => {
    const doc = await run(
      parseDocument({ format: "txt", fileContent: Buffer.from("第一章 考勤制度").toString("base64") }),
    )
    expect(doc.text).toBe("第一章 考勤制度")
  })

  it("parses markdown", async () => {
    const doc = await run(
      parseDocument({ format: "md", fileContent: Buffer.from("# 标题\n正文内容").toString("base64") }),
    )
    expect(doc.text).toContain("标题")
    expect(doc.text).toContain("正文内容")
  })

  it("extracts text from a minimal PDF", () => {
    const pdf = makeMinimalPdf(["Hello World", "This is a test"])
    const text = extractPdfText(pdf)
    expect(text).toContain("Hello World")
    expect(text).toContain("This is a test")
  })

  it("parses pdf through parseDocument", async () => {
    const pdf = makeMinimalPdf(["第一章 考勤制度"])
    const doc = await run(
      parseDocument({ format: "pdf", fileContent: Buffer.from(pdf).toString("base64") }),
    )
    expect(doc.text).toContain("第一章 考勤制度")
  })

  it("parses docx text", async () => {
    const docx = await makeDocx("员工手册")
    const doc = await run(
      parseDocument({ format: "docx", fileContent: Buffer.from(docx).toString("base64") }),
    )
    expect(doc.text).toContain("员工手册")
  })

  it("returns empty text for unsupported formats", async () => {
    const doc = await run(
      parseDocument({ format: "xlsx", fileContent: Buffer.from("garbage").toString("base64") }),
    )
    expect(doc.text).toBe("")
  })
})
