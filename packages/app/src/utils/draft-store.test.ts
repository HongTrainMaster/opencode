import { afterEach, describe, expect, test } from "bun:test"
import { createBlobReference, createDraftStore } from "./draft-store"

const originalSubtle = globalThis.crypto?.subtle

afterEach(() => {
  if (originalSubtle) Object.defineProperty(globalThis.crypto, "subtle", { value: originalSubtle })
  else delete (globalThis.crypto as { subtle?: unknown }).subtle
})

describe("createBlobReference", () => {
  test("produces a sha-256 id when crypto.subtle is available", async () => {
    const blob = new Blob(["hello"])
    const ref = await createBlobReference(blob)
    expect(ref.id).toMatch(/^[0-9a-f]{64}$/)
    expect(ref.url.startsWith("blob:")).toBe(true)
  })

  test("falls back to a random id when crypto.subtle is unavailable (http iframe)", async () => {
    Object.defineProperty(globalThis.crypto, "subtle", { value: undefined })
    const blob = new Blob(["hello"])
    const ref = await createBlobReference(blob)
    expect(ref.id.startsWith("blob-")).toBe(true)
    expect(ref.url.startsWith("blob:")).toBe(true)
  })
})

describe("createDraftStore", () => {
  test("putBlob works when crypto.subtle is unavailable (http iframe)", async () => {
    Object.defineProperty(globalThis.crypto, "subtle", { value: undefined })
    const stored = new Map<string, Blob>()
    const store = createDraftStore({
      get: async (key) => null,
      set: async (key, value) => void 0,
      remove: async (key) => void 0,
      putBlob: async (blob) => {
        const id = `blob-${stored.size}`
        stored.set(id, blob)
        return id
      },
      getBlob: async (id) => stored.get(id) ?? null,
    })
    const blob = new Blob(["draft content"])
    const ref = await store.putBlob(blob)
    expect(ref.id).toBe("blob-0")
    expect(ref.url.startsWith("blob:")).toBe(true)
    expect(stored.size).toBe(1)
  })
})