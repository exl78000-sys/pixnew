import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 1024,
  height: 640,
  backgroundColor: "#1a1626",
  pixelArt: true,
  scene: [BootScene]
});
