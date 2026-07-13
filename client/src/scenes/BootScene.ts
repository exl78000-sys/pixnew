import Phaser from "phaser";
import { SocketClient } from "../net/SocketClient";
import type { ClockState } from "@pixnew/shared";

const FONT = '"Cubic11", "Microsoft JhengHei", sans-serif';

/**
 * M0 開機場景:標題 + 後端心跳時鐘 + 速度按鈕。
 * M1-T1 之後會被 ApartmentScene 取代為主場景。
 */
export class BootScene extends Phaser.Scene {
  private socket!: SocketClient;
  private clockText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  constructor() {
    super("Boot");
  }

  create(): void {
    const { width, height } = this.scale;

    this.add
      .text(width / 2, height / 2 - 60, "AI 魚缸公寓", {
        fontFamily: FONT, fontSize: "48px", color: "#ffd97a"
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height / 2 - 10, "6 個 AI 室友,劇本沒人寫。", {
        fontFamily: FONT, fontSize: "18px", color: "#b8a9d9"
      })
      .setOrigin(0.5);

    this.clockText = this.add
      .text(16, 16, "連線中…", {
        fontFamily: FONT, fontSize: "16px", color: "#8ee6a5"
      });

    this.statusText = this.add
      .text(width / 2, height / 2 + 60, "等待後端心跳…", {
        fontFamily: FONT, fontSize: "14px", color: "#6f6291"
      })
      .setOrigin(0.5);

    // 速度按鈕(⏸ / 1x / 4x / 16x)
    const speeds: Array<0 | 1 | 4 | 16> = [0, 1, 4, 16];
    speeds.forEach((s, i) => {
      const label = s === 0 ? "⏸" : `${s}x`;
      this.add
        .text(16 + i * 56, height - 40, label, {
          fontFamily: FONT, fontSize: "18px", color: "#e8e0f5",
          backgroundColor: "#3a2f55", padding: { x: 10, y: 6 }
        })
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => this.socket.send({ type: "set_speed", speed: s }));
    });

    this.socket = new SocketClient();
    this.socket.onMessage((msg) => {
      if (msg.type === "clock") this.renderClock(msg.clock);
      if (msg.type === "world_state") this.renderClock(msg.clock);
    });
  }

  private renderClock(clock: ClockState): void {
    const speedLabel = clock.speed === 0 ? "⏸ 暫停" : `${clock.speed}x`;
    this.clockText.setText(`第 ${clock.day} 天  ${clock.hhmm}  [${speedLabel}]`);
    this.statusText.setText("後端心跳正常 — M0 骨架運作中");
  }
}
