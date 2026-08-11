// JWT signature verification for the business-system integration.
//
// The knowledge system's JWT is issued by a Sa-Token backend and is an HS256
// token signed with the shared `jwt-secret-key`. The opencode server must NOT
// trust the payload claims of a token it cannot verify — otherwise any client
// that reaches the HTTP API can mint an identity and read every user's
// sessions. This module verifies the signature (HMAC or asymmetric via a
// configured public key / JWKS) and the exp/nbf claims before the payload is
// used for identity resolution.
//
// Configuration (all optional; if none is set, verification fails closed):
//   - KNOWLEDGE_JWT_SECRET      HMAC secret for HS256/HS384/HS512 (sa-token jwt-secret-key)
//   - KNOWLEDGE_JWT_PUBLIC_KEY  PEM public key for RS/PS/ES algorithms
//   - KNOWLEDGE_JWT_JWKS_URL    JWKS endpoint to fetch the signing key (kid-matched)
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto"

export interface JwtVerifierConfig {
  /** HMAC secret for HS256/384/512. */
  readonly secret?: string
  /** PEM-encoded public key for RS/PS/ES algorithms. */
  readonly publicKeyPem?: string
  /** JWKS endpoint URL. */
  readonly jwksUrl?: string
}

export interface VerifiedJwt {
  readonly header: Record<string, unknown>
  readonly payload: Record<string, unknown>
}

interface ParsedJwt {
  readonly header: Record<string, unknown>
  readonly payload: Record<string, unknown>
  readonly signingInput: string
  readonly signature: Buffer
}

const HS_ALGS: Record<string, string> = { HS256: "sha256", HS384: "sha384", HS512: "sha512" }
const RS_ALGS: Record<string, string> = { RS256: "sha256", RS384: "sha384", RS512: "sha512" }
const PS_ALGS: Record<string, string> = { PS256: "sha256", PS384: "sha384", PS512: "sha512" }
const ES_ALGS: Record<string, string> = { ES256: "sha256", ES384: "sha384", ES512: "sha512" }

function decodeSegment(segment: string): Buffer | undefined {
  try {
    let base64 = segment.replace(/-/g, "+").replace(/_/g, "/")
    while (base64.length % 4) base64 += "="
    return Buffer.from(base64, "base64")
  } catch {
    return undefined
  }
}

function parseJwt(token: string): ParsedJwt | undefined {
  if (typeof token !== "string") return undefined
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  const [headerB64, payloadB64, signatureB64] = parts
  const headerBuf = decodeSegment(headerB64!)
  const payloadBuf = decodeSegment(payloadB64!)
  const signature = decodeSegment(signatureB64!)
  if (!headerBuf || !payloadBuf || !signature) return undefined
  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(headerBuf.toString())
    payload = JSON.parse(payloadBuf.toString())
  } catch {
    return undefined
  }
  if (typeof header !== "object" || header === null || typeof payload !== "object" || payload === null) {
    return undefined
  }
  return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature }
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Convert a raw r||s JWT signature into the DER encoding crypto.verify expects. */
function rawToDerSignature(raw: Buffer): Buffer {
  const half = raw.length / 2
  const toInteger = (buf: Buffer): Buffer => {
    let start = 0
    while (start < buf.length - 1 && buf[start] === 0) start++
    let value = buf.subarray(start)
    if (value[0]! & 0x80) value = Buffer.concat([Buffer.from([0]), value])
    return value
  }
  const r = toInteger(raw.subarray(0, half))
  const s = toInteger(raw.subarray(half))
  return Buffer.concat([
    Buffer.from([0x30, 0x02 + r.length + s.length]),
    Buffer.from([0x02, r.length]),
    r,
    Buffer.from([0x02, s.length]),
    s,
  ])
}

function verifyHmac(alg: string, signingInput: string, signature: Buffer, secret: string): boolean {
  const hash = HS_ALGS[alg]
  if (!hash || !secret) return false
  const expected = createHmac(hash, secret).update(signingInput).digest()
  return constantTimeEqual(expected, signature)
}

function verifyAsymmetric(alg: string, signingInput: string, signature: Buffer, key: KeyObject): boolean {
  const rsHash = RS_ALGS[alg]
  if (rsHash) {
    try {
      return cryptoVerify(rsHash, Buffer.from(signingInput), { key, padding: 1 }, signature)
    } catch {
      return false
    }
  }
  const psHash = PS_ALGS[alg]
  if (psHash) {
    try {
      return cryptoVerify(psHash, Buffer.from(signingInput), { key, padding: 3, saltLength: undefined }, signature)
    } catch {
      return false
    }
  }
  const esHash = ES_ALGS[alg]
  if (esHash) {
    try {
      return cryptoVerify(esHash, Buffer.from(signingInput), key, rawToDerSignature(signature))
    } catch {
      return false
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// JWKS support
// ---------------------------------------------------------------------------

interface JwksKey {
  readonly kid?: string
  readonly kty: string
  readonly alg?: string
  readonly use?: string
  readonly [k: string]: unknown
}

let jwksCache: { url: string; keys: JwksKey[]; fetchedAt: number } | undefined
const JWKS_TTL_MS = 60 * 60 * 1000

async function fetchJwks(url: string): Promise<JwksKey[] | undefined> {
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return undefined
    const body = (await res.json()) as { keys?: JwksKey[] }
    const keys = Array.isArray(body.keys) ? body.keys : []
    jwksCache = { url, keys, fetchedAt: Date.now() }
    return keys
  } catch {
    return undefined
  }
}

function findJwksKey(keys: JwksKey[], kid?: string, alg?: string): JwksKey | undefined {
  if (kid) {
    const byKid = keys.find((k) => k.kid === kid)
    if (byKid) return byKid
  }
  // Fall back to the first key usable for this algorithm family.
  const family = alg?.startsWith("RS") || alg?.startsWith("PS") ? "RSA" : alg?.startsWith("ES") ? "EC" : undefined
  const usable = keys.filter((k) => k.use === undefined || k.use === "sig")
  if (family) {
    const matched = usable.find((k) => k.kty === family)
    if (matched) return matched
  }
  return usable[0]
}

function importJwksKey(key: JwksKey): KeyObject | undefined {
  try {
    if (key.kty === "RSA") {
      return createPublicKey({
        key: { kty: "RSA", n: key.n, e: key.e } as never,
        format: "jwk",
      })
    }
    if (key.kty === "EC") {
      return createPublicKey({
        key: { kty: "EC", crv: key.crv, x: key.x, y: key.y } as never,
        format: "jwk",
      })
    }
    return undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a JWT's signature and temporal claims (exp/nbf) against the given
 * config. Returns the verified header/payload, or `undefined` when the token
 * is unverifiable (malformed, tampered, expired, unknown algorithm, or no key
 * configured). Callers must treat `undefined` as "do not trust this token".
 */
export async function verifyJwt(token: string, config: JwtVerifierConfig): Promise<VerifiedJwt | undefined> {
  const parsed = parseJwt(token)
  if (!parsed) return undefined

  const alg = typeof parsed.header.alg === "string" ? parsed.header.alg : ""
  if (!alg) return undefined

  let valid = false
  if (HS_ALGS[alg]) {
    if (!config.secret) return undefined
    valid = verifyHmac(alg, parsed.signingInput, parsed.signature, config.secret)
  } else if (RS_ALGS[alg] || PS_ALGS[alg] || ES_ALGS[alg]) {
    let key: KeyObject | undefined
    if (config.publicKeyPem) {
      try {
        key = createPublicKey(config.publicKeyPem)
      } catch {
        return undefined
      }
    } else if (config.jwksUrl) {
      const keys = await fetchJwks(config.jwksUrl)
      const kid = typeof parsed.header.kid === "string" ? parsed.header.kid : undefined
      const jwksKey = keys ? findJwksKey(keys, kid, alg) : undefined
      key = jwksKey ? importJwksKey(jwksKey) : undefined
    }
    if (!key) return undefined
    valid = verifyAsymmetric(alg, parsed.signingInput, parsed.signature, key)
  } else {
    // Unknown algorithm — reject.
    return undefined
  }

  if (!valid) return undefined

  // Temporal validation (epoch seconds). Missing claims are tolerated so that
  // tokens with no explicit expiration still work; present-but-invalid claims
  // are rejected.
  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof parsed.payload.exp === "number" && parsed.payload.exp < nowSec) return undefined
  if (typeof parsed.payload.nbf === "number" && parsed.payload.nbf > nowSec) return undefined

  return { header: parsed.header, payload: parsed.payload }
}

/** True when any verification key material is configured. */
export function hasJwtVerificationConfig(config: JwtVerifierConfig): boolean {
  return Boolean(config.secret || config.publicKeyPem || config.jwksUrl)
}
