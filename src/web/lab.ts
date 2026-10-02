/**
 * 見比べ画面（`web/lab.html`）の中身。**検証用でゲーム本体には出ない。**
 *
 * 🔴 ここもゲームの規則を1行も持たない。両方の描き方を**同じ条件で**並べて、
 *    動きの幅がどれだけ違うかを目で確かめるためだけのもの。
 */

import * as Sprites from "./sprites.ts";
import * as Voxel from "./voxel.ts";
import type { Pose } from "./voxel.ts";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`見比べ画面に #${id} が無い`);
  return n as T;
}

/* 🔑 色は試合画面のホームと同じにする。見比べるとき条件を変えない */
const KIT: Voxel.Kit = {
  shirt: "#f2a714", shorts: "#3b2a1b", skin: "#f7cfa4",
  hair: "#3b2a1b", socks: "#f2a714", shoes: "#2b2b33",
};
const SPRITE_KIT = {
  shirt: "#f2a714", shirtDark: "#c7820a", shorts: "#3b2a1b",
  skin: "#f7cfa4", hair: "#3b2a1b", socks: "#f2a714",
};

/* 🔴 ドット絵の側には **stand と run と cheer しか無い**（それが今回の論点）。
      sprint は run のコマを速く送っているだけで、絵は同じ。
      kick と tired は**描かれていないので出せない**。 */
const POSES: { key: Pose; label: string; sprite: Sprites.Act | null }[] = [
  { key: "stand", label: "立つ", sprite: "stand" },
  { key: "run", label: "走る", sprite: "run" },
  { key: "sprint", label: "全力", sprite: "sprint" },
  { key: "kick", label: "蹴る", sprite: null },
  { key: "cheer", label: "喜ぶ", sprite: "cheer" },
  { key: "tired", label: "息切れ", sprite: null },
];

let pose: Pose = "run";
let facing = (200 * Math.PI) / 180;
let camYaw = (90 * Math.PI) / 180;
let camPitch = (32 * Math.PI) / 180;
let speed = 1;
let spinning = false;

function renderPoseRow(): void {
  const row = $("poseRow");
  row.textContent = "";
  for (const p of POSES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chip${p.key === pose ? " is-on" : ""}`;
    b.textContent = p.label + (p.sprite === null ? "（ドット絵に無い）" : "");
    b.addEventListener("click", () => { pose = p.key; renderPoseRow(); });
    row.append(b);
  }
}

/** 左: いまのドット絵。8方向のうち、向きに一番近い1枚を出す */
function drawOld(t: number): void {
  const cv = $<HTMLCanvasElement>("oldCanvas");
  const c = cv.getContext("2d");
  if (c === null) return;
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, cv.width, cv.height);

  const entry = POSES.find((p) => p.key === pose)!;
  if (entry.sprite === null) {
    /* 🔴 ここが要点。**その姿勢の絵が存在しない**ので何も出せない。
          新しい動きを足すには 8方向×4コマ＝32枚を描き足す必要がある。 */
    c.fillStyle = "#1b2a3c";
    c.font = "bold 16px sans-serif";
    c.textAlign = "center";
    c.fillText("この動きの絵は無い", cv.width / 2, cv.height / 2 - 10);
    c.font = "13px sans-serif";
    c.fillText("8方向×4コマ＝32枚を描き足す必要がある", cv.width / 2, cv.height / 2 + 14);
    c.textAlign = "left";
    return;
  }

  /* 🔑 画面上の向きで絵を選ぶ。カメラを回すと見え方が変わるので、
        体の向きとカメラの向きの差を使う */
  const rel = facing - camYaw + Math.PI / 2;
  const dir = Sprites.dirOf(rel);
  const cycle = pose === "sprint" ? 11 : pose === "run" ? 7.5 : 2.2;
  const frame = Math.floor(t * cycle * speed) % Sprites.RUN_FRAMES;
  const img = Sprites.get("lab", SPRITE_KIT, dir, frame, entry.sprite);

  const scale = 14;
  const w = Sprites.W * scale;
  const h = Sprites.H * scale;
  /* 影 */
  c.fillStyle = "rgba(10,40,15,.30)";
  c.beginPath();
  c.ellipse(cv.width / 2, cv.height / 2 + h / 2 - scale, w * 0.3, w * 0.12, 0, 0, Math.PI * 2);
  c.fill();
  c.drawImage(img, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}

/** 右: ブロック3D */
function drawNew(t: number): void {
  const cv = $<HTMLCanvasElement>("newCanvas");
  const c = cv.getContext("2d");
  if (c === null) return;
  c.clearRect(0, 0, cv.width, cv.height);

  const cam: Voxel.Cam = {
    yaw: camYaw,
    pitch: camPitch,
    /* 🔑 左のドット絵と**見かけの大きさを揃える**。揃えないと
          「3Dのほうが小さい」のか「作りが違う」のか区別できず、比較にならない。 */
    dist: 2.9,
    focal: 620,
    target: { x: 0, y: 0, z: 0.72 },
    cx: cv.width / 2,
    cy: cv.height * 0.56,
  };
  const at = { x: 0, y: 0, z: 0 };
  Voxel.drawShadow(c, cam, at);
  Voxel.drawPlayer(c, cam, { at, facing, pose, t: t * speed, kit: KIT });
}

function fmtDeg(rad: number): string {
  return `${Math.round(((rad * 180) / Math.PI + 360) % 360)}°`;
}

function main(): void {
  renderPoseRow();

  const bind = (id: string, valId: string, set: (v: number) => void,
                fmt: (v: number) => string): void => {
    const el = $<HTMLInputElement>(id);
    const out = $(valId);
    const apply = (): void => {
      set(Number(el.value));
      out.textContent = fmt(Number(el.value));
    };
    el.addEventListener("input", apply);
    apply();
  };
  bind("yaw", "yawVal", (v) => { facing = (v * Math.PI) / 180; }, (v) => `${v}°`);
  bind("camYaw", "camYawVal", (v) => { camYaw = (v * Math.PI) / 180; }, (v) => `${v}°`);
  bind("camPitch", "camPitchVal", (v) => { camPitch = (v * Math.PI) / 180; }, (v) => `${v}°`);
  bind("speed", "speedVal", (v) => { speed = v / 100; }, (v) => `${(v / 100).toFixed(2)}x`);

  $("spin").addEventListener("click", () => {
    spinning = !spinning;
    $("spin").textContent = spinning ? "回すのをやめる" : "カメラを回す";
  });

  /* 体つきのつまみ。`SHAPE` を直接書き換える（次のコマから反映される） */
  bind("headRatio", "headRatioVal",
       (v) => { Voxel.SHAPE.headRatio = v / 100; }, (v) => `${v}%`);
  bind("headWidth", "headWidthVal",
       (v) => { Voxel.SHAPE.headWidth = v / 100; }, (v) => `${(v / 100).toFixed(2)}m`);
  bind("bodyWidth", "bodyWidthVal",
       (v) => { Voxel.SHAPE.bodyWidth = v / 100; }, (v) => `${(v / 100).toFixed(2)}m`);
  bind("legRatio", "legRatioVal",
       (v) => { Voxel.SHAPE.legRatio = v / 100; }, (v) => `${v}%`);

  $("reset").addEventListener("click", () => {
    const d: [string, number][] = [["headRatio", 35], ["headWidth", 50],
                                   ["bodyWidth", 54], ["legRatio", 48]];
    for (const [id, v] of d) {
      const el = $<HTMLInputElement>(id);
      el.value = String(v);
      el.dispatchEvent(new Event("input"));
    }
  });

  const t0 = performance.now();
  const loop = (now: number): void => {
    const t = (now - t0) / 1000;
    if (spinning) {
      camYaw = (t * 0.6) % (Math.PI * 2);
      const el = $<HTMLInputElement>("camYaw");
      el.value = String(Math.round((camYaw * 180) / Math.PI));
      $("camYawVal").textContent = fmtDeg(camYaw);
    }
    drawOld(t);
    drawNew(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();
