import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // 開發時把 WebSocket 與 API 轉給本地後端
      "/ws": { target: "ws://127.0.0.1:3001", ws: true },
      "/health": { target: "http://127.0.0.1:3001" }
    }
  }
});
