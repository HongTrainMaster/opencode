import { describe, expect, it } from "bun:test"
import { createHmac, generateKeyPairSync, createSign } from "node:crypto"
import { verifyJwt, hasJwtVerificationConfig, type JwtVerifierConfig } from "./jwt-verify"

const SECRET = "abcdefghijklmnopqrstuvwxyz"

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url")
}

function signHs256(payload: Record<string, unknown>, secret: string, header: Record<string, unknown> = {}): string {
  const signingInput = `${b64url({ alg: "HS256", typ: "JWT", ...header })}.${b64url(payload)}`
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url")
  return `${signingInput}.${sig}`
}

describe("verifyJwt (HS256)", () => {
  const config: JwtVerifierConfig = { secret: SECRET }

  it("accepts a correctly signed token", async () => {
    const token = signHs256({ userId: 1001, userName: "Alice", tenantId: "tenant_01" }, SECRET)
    const verified = await verifyJwt(token, config)
    expect(verified?.payload.userId).toBe(1001)
    expect(verified?.payload.userName).toBe("Alice")
  })

  it("rejects a tampered payload", async () => {
    const good = signHs256({ userId: 1001, userName: "Alice", tenantId: "tenant_01" }, SECRET)
    const [headerB64, , sig] = good.split(".")
    const forged = `${headerB64}.${b64url({ userId: 9999, userName: "Admin", tenantId: "tenant_01" })}.${sig}`
    expect(await verifyJwt(forged, config)).toBeUndefined()
  })

  it("rejects a token signed with the wrong secret", async () => {
    const token = signHs256({ userId: 1001 }, "wrong-secret")
    expect(await verifyJwt(token, config)).toBeUndefined()
  })

  it("rejects an expired token", async () => {
    const token = signHs256({ userId: 1001, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET)
    expect(await verifyJwt(token, config)).toBeUndefined()
  })

  it("rejects a token with a not-before claim in the future", async () => {
    const token = signHs256({ userId: 1001, nbf: Math.floor(Date.now() / 1000) + 3600 }, SECRET)
    expect(await verifyJwt(token, config)).toBeUndefined()
  })

  it("accepts a token with a valid exp", async () => {
    const token = signHs256({ userId: 1001, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)
    expect((await verifyJwt(token, config))?.payload.userId).toBe(1001)
  })

  it("fails closed when no key material is configured", async () => {
    const token = signHs256({ userId: 1001 }, SECRET)
    expect(await verifyJwt(token, {})).toBeUndefined()
  })

  it("rejects malformed tokens", async () => {
    expect(await verifyJwt("not-a-jwt", config)).toBeUndefined()
    expect(await verifyJwt("a.b", config)).toBeUndefined()
    expect(await verifyJwt("", config)).toBeUndefined()
    expect(await verifyJwt(undefined as unknown as string, config)).toBeUndefined()
  })

  it("rejects an unknown algorithm", async () => {
    const token = signHs256({ userId: 1001 }, SECRET, { alg: "none" })
    expect(await verifyJwt(token, config)).toBeUndefined()
  })
})

describe("verifyJwt (RS256)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const config: JwtVerifierConfig = { publicKeyPem: publicKey.export({ type: "pkcs1", format: "pem" }).toString() }

  function signRs256(payload: Record<string, unknown>): string {
    const signingInput = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}`
    const sig = createSign("sha256").update(signingInput).sign(privateKey).toString("base64url")
    return `${signingInput}.${sig}`
  }

  it("accepts a correctly signed RS256 token", async () => {
    const token = signRs256({ userId: 7, userName: "RsaUser", tenantId: "t" })
    const verified = await verifyJwt(token, config)
    expect(verified?.payload.userId).toBe(7)
  })

  it("rejects a tampered RS256 token", async () => {
    const token = signRs256({ userId: 7 })
    const [headerB64, , sig] = token.split(".")
    const forged = `${headerB64}.${b64url({ userId: 99 })}.${sig}`
    expect(await verifyJwt(forged, config)).toBeUndefined()
  })
})

describe("hasJwtVerificationConfig", () => {
  it("is false when nothing is configured", () => {
    expect(hasJwtVerificationConfig({})).toBe(false)
  })
  it("is true when a secret is configured", () => {
    expect(hasJwtVerificationConfig({ secret: "x" })).toBe(true)
  })
  it("is true when a jwks url is configured", () => {
    expect(hasJwtVerificationConfig({ jwksUrl: "https://x/.well-known/jwks.json" })).toBe(true)
  })
})
