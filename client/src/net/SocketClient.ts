import type { ClientMessage, ServerMessage } from "@pixnew/shared";

type Handler = (msg: ServerMessage) => void;

/**
 * 與後端的 WebSocket 連線。斷線後 3 秒自動重連。
 */
export class SocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private url: string;

  constructor() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.url = `${proto}://${location.host}/ws`;
    this.connect();
  }

  onMessage(handler: Handler): void {
    this.handlers.add(handler);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        for (const h of this.handlers) h(msg);
      } catch {
        // 忽略無法解析的訊息
      }
    };
    this.ws.onclose = () => {
      setTimeout(() => this.connect(), 3000);
    };
    this.ws.onerror = () => {
      this.ws?.close();
    };
  }
}
