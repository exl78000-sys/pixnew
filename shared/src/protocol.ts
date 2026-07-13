/**
 * 前後端共用的 WebSocket 協定型別。
 * 後端是模擬的唯一事實來源;前端只渲染這些訊息。
 */

/** 模擬時間:自模擬開始起的「模擬分鐘」總數 */
export interface ClockState {
  simTime: number;
  /** 第幾天(從 1 起算) */
  day: number;
  /** "HH:MM" 形式的當日時刻 */
  hhmm: string;
  /** 0 = 暫停,1 / 4 / 16 = 倍速 */
  speed: number;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  x: number;
  y: number;
  room: string;
  mood: string;
  currentAction: string;
}

// ── 伺服器 → 前端 ────────────────────────────────

export type ServerMessage =
  | { type: "clock"; clock: ClockState }
  | { type: "world_state"; agents: AgentSnapshot[]; clock: ClockState }
  | { type: "agent_update"; agent: AgentSnapshot }
  | { type: "dialogue"; speakerId: string; text: string; done: boolean }
  | { type: "event"; summary: string; importance: number }
  | { type: "budget_warning"; spentUsd: number; limitUsd: number };

// ── 前端 → 伺服器 ────────────────────────────────

export type ClientMessage =
  | { type: "set_speed"; speed: 0 | 1 | 4 | 16 }
  | { type: "play_card"; cardId: string; target: string }
  | { type: "save"; name: string }
  | { type: "load"; saveId: string };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    if (typeof msg === "object" && msg !== null && typeof msg.type === "string") {
      return msg;
    }
    return null;
  } catch {
    return null;
  }
}

/** 把模擬分鐘換算為 day / hhmm */
export function simTimeToClock(simTime: number, speed: number): ClockState {
  const day = Math.floor(simTime / 1440) + 1;
  const minuteOfDay = simTime % 1440;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const mm = String(minuteOfDay % 60).padStart(2, "0");
  return { simTime, day, hhmm: `${hh}:${mm}`, speed };
}
