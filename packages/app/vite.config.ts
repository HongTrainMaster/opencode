import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  base: "/knowledge/",
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    // 允许跨包 @fs/ 路径（npm workspace monorepo）
    fs: { strict: false },
    // 开发时 API 代理到后端 4096
    proxy: {
      "/knowledge/api": "http://127.0.0.1:4096",
      "/global": "http://127.0.0.1:4096",
      "/provider": "http://127.0.0.1:4096",
      "/project": "http://127.0.0.1:4096",
      "/config": "http://127.0.0.1:4096",
      "/agent": "http://127.0.0.1:4096",
      "/session": "http://127.0.0.1:4096",
      "/experimental": "http://127.0.0.1:4096",
      "/site.webmanifest": "http://127.0.0.1:4096",
      "/favicon": "http://127.0.0.1:4096",
      "/apple-touch-icon": "http://127.0.0.1:4096",
      "/social-share": "http://127.0.0.1:4096",
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
