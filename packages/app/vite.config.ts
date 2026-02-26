import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { VitePWA } from "vite-plugin-pwa"
import path from "path"

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.ico"],
      manifest: {
        name: "Junction",
        short_name: "Junction",
        description: "Distributed AI Agent Platform",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@server": path.resolve(__dirname, "../server/src"),
      "@api": path.resolve(__dirname, "../api/src"),
    },
  },
  server: {
    port: 5173,
  },
})
