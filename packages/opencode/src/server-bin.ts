// OpenCode Server binary entry point
// Usage: opencode-server.exe [--port 4096] [--hostname 127.0.0.1]

const port = parseInt(process.env.OPENCODE_PORT || process.argv.find(a => a.startsWith("--port="))?.split("=")[1] || "4096")
const hostname = process.env.OPENCODE_HOST || process.argv.find(a => a.startsWith("--hostname="))?.split("=")[1] || "127.0.0.1"

// Set default env for server mode. The models file provides the offline /
// subscription catalog (console, console-go); network fetching stays enabled
// so the community catalog from models.dev is available too.
if (!process.env.OPENCODE_MODELS_PATH) process.env.OPENCODE_MODELS_PATH = process.env.HOME + "/.opencode/models.json"

async function main() {
  const { Server } = await import("./server/server")
  const server = await Server.listen({ port, hostname })
  console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
  // Keep process alive
  await new Promise(() => {})
}

main().catch((err) => {
  console.error("Server failed to start:", err)
  process.exit(1)
})
