import "dotenv/config";
import Fastify from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import {
  parseClientMessage,
  simTimeToClock,
  type ServerMessage
} from "@pixnew/shared";

const PORT = Number(process.env.SERVER_PORT ?? 3001);

const app = Fastify({ logger: false });

app.get("/health", async () => ({ ok: true, name: "pixnew-server" }));

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`[server] http://127.0.0.1:${PORT}  (health: /health, ws: /ws)`);

// ── WebSocket:掛在同一個 HTTP server 上 ──────────────────
const wss = new WebSocketServer({ server: app.server, path: "/ws" });

function broadcast(msg: ServerMessage) {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  }
}

// ── M0 心跳時鐘(M1-T3 會由真正的 sim/Clock 取代)────────
// 現實 2 秒 = 1 模擬分鐘;speed 之後才會可調
let simTime = 7 * 60; // 從第 1 天 07:00 開始,看起來像個一天的開頭
let speed: 0 | 1 | 4 | 16 = 1;

setInterval(() => {
  if (speed === 0) return;
  simTime += 1;
  broadcast({ type: "clock", clock: simTimeToClock(simTime, speed) });
}, 2000);

wss.on("connection", (socket) => {
  console.log("[server] 前端已連線");
  // 連線時先給一次目前狀態(M1 後會是完整 world_state)
  const hello: ServerMessage = {
    type: "world_state",
    agents: [],
    clock: simTimeToClock(simTime, speed)
  };
  socket.send(JSON.stringify(hello));

  socket.on("message", (data) => {
    const msg = parseClientMessage(String(data));
    if (!msg) return;
    if (msg.type === "set_speed" && msg.speed !== speed) {
      speed = msg.speed;
      broadcast({ type: "clock", clock: simTimeToClock(simTime, speed) });
      console.log(`[server] 速度切換 → ${speed}x`);
    }
  });
});
