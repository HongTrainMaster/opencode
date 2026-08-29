import { describe, expect, test } from "bun:test"
import { attachmentMime } from "./attachments"

describe("prompt input v2 attachmentMime", () => {
  test("keeps docx mime reported by the browser", async () => {
    const file = new File(["PK\x03\x04fake"], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
    expect(await attachmentMime(file)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  })

  test("accepts docx by suffix even when the browser reports application/zip", async () => {
    const file = new File(["PK\x03\x04fake"], "report.docx", { type: "application/zip" })
    expect(await attachmentMime(file)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  })

  test("accepts docx by suffix when the browser reports an empty or octet-stream mime", async () => {
    const empty = new File(["PK\x03\x04fake"], "report.docx", { type: "" })
    expect(await attachmentMime(empty)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    const octet = new File(["PK\x03\x04fake"], "report.docx", { type: "application/octet-stream" })
    expect(await attachmentMime(octet)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  })

  test("accepts pdf by suffix even when the browser reports application/zip", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/zip" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})