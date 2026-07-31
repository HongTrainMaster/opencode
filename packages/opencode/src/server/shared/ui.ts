import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (scriptHashes = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${scriptHashes ? ` ${scriptHashes}` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`
export const DEFAULT_CSP = csp()

export function cspForHtml(body: string) {
  const hashes = allInlineScriptHashes(body)
  return csp(hashes.map((h) => `'sha256-${h}'`).join(" "))
}

function allInlineScriptHashes(body: string): string[] {
  const regex = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi
  const hashes: string[] = []
  let match
  while ((match = regex.exec(body)) !== null) {
    hashes.push(createHash("sha256").update(match[1]).digest("base64"))
  }
  return hashes
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

/** Inject a script into the HTML that sets window.__USER_INFO__ from the /knowledge/api/workspaces
 * endpoint, so the KnowledgeHome component can display workspaces without a server-side injection of
 * the global variable. Also extracts the auth token from query params for session links.
 * The Bearer token is passed as a query param because nginx overwrites the Authorization header. */
function injectKnowledgeUserInfo(body: string, requestUrl: string): string {
  const url = new URL(requestUrl, "http://localhost")
  const authParam = url.searchParams.get("Authorization") ?? url.searchParams.get("auth_token") ?? ""
  const script = `<script>
;(async function(){
  try {
    var params = new URLSearchParams(location.search);
    var bearer = params.get("Authorization");
    var apiUrl = bearer
      ? "/knowledge/api/workspaces?Authorization=" + encodeURIComponent(bearer)
      : "/knowledge/api/workspaces";
    var r = await fetch(apiUrl);
    if (r.ok) {
      var d = await r.json();
      window.__USER_INFO__ = { workspaces: d.data ?? [], nickName: "" };
    }
  } catch(e) { console.warn("[knowledge] failed to load workspaces", e); }
})();
window.__INITIAL_AUTH_TOKEN__ = window.__INITIAL_AUTH_TOKEN__ || ${JSON.stringify(authParam)};
</script>`
  // Inject before </head> if present, otherwise before </body>
  const headIdx = body.lastIndexOf("</head>")
  if (headIdx !== -1) return body.slice(0, headIdx) + script + body.slice(headIdx)
  const bodyIdx = body.lastIndexOf("</body>")
  if (bodyIdx !== -1) return body.slice(0, bodyIdx) + script + body.slice(bodyIdx)
  return script + body
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname
    const isKnowledgePage = path === "/knowledge" || path.startsWith("/knowledge/session/")

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      let body = yield* response.text
      if (isKnowledgePage) {
        body = injectKnowledgeUserInfo(body, request.url)
      }
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
