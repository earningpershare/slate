/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // relative, so the build works from any address, including a sub-path like user.github.io/slate/
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: "Slate 離線工作區",
        short_name: "Slate",
        description: "離線的筆記、資料庫與待辦工作區，用連結碼在裝置之間直接同步",
        theme_color: "#fbfaf7",
        background_color: "#fbfaf7",
        display: "standalone",
        orientation: "any",
        // phones need PNG icons; the maskable one has no rounded corners of its own
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
    }),
  ],
  server: { port: 5183 },
  test: { environment: "node" },
});
