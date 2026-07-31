import { test, expect } from "@playwright/test"

test.describe("knowledge sidebar", () => {
  test("page loads without errors and fetches workspaces", async ({ page }) => {
    const requests: string[] = []
    const consoleErrors: string[] = []

    page.on("request", (req) => requests.push(req.url()))
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", (err) => consoleErrors.push(err.message))

    // Navigate to knowledge page with a fake Bearer token
    // (it'll be rejected by the business API, but the fetch should still be attempted)
    await page.goto("/knowledge?Authorization=Bearer%20test-playwright-token", {
      waitUntil: "networkidle",
    })

    // Check page rendered with the knowledge-home container
    const container = page.locator(".knowledge-home")
    await expect(container).toBeVisible({ timeout: 10_000 })

    // Check that a fetch to /knowledge/api/workspaces was attempted
    const workspaceApiCalls = requests.filter((u) => u.includes("/knowledge/api/workspaces"))
    expect(workspaceApiCalls.length).toBeGreaterThanOrEqual(1)

    // Verify the Bearer token was passed in the URL
    const withToken = workspaceApiCalls.filter((u) => u.includes("Authorization="))
    expect(withToken.length).toBeGreaterThanOrEqual(1)

    // No unhandled page errors
    expect(consoleErrors.filter((e) => !e.includes("Failed to load resource")).length).toBe(0)
  })
})
