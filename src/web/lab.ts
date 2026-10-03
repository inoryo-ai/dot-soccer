/**
 * 選手パーツの確認台（`web/lab.html`）。**検証用でゲーム本体には出ない。**
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 これは何のためのページか
 * ─────────────────────────────────────────────────────────────
 * 選手1体を、姿勢・向き・カメラ・体つきを変えながら**1体だけ**で見る台。
 * 試合画面の中で見ると、22人が重なって動いているので、
 * 「いまの蹴り方が変か」「頭が大きすぎないか」を1つずつ確かめられない。
 *
 * 🔴 ここもゲームの規則を1行も持たない。
 *
 * 🗑 2026-10-03: もとは**2Dドット絵と3Dの見比べ**ページだった。
 *    3Dに一本化した（D-33）ので、見比べる相手が無くなり、
 *    「選手パーツを単体で確かめる台」に作り変えた。
 */

import * as Voxel from "./voxel.ts";
import type { Pose } from "./voxel.ts";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`確認台に #${id} が無い`);
  return n as T;
}

/* 🔑 色は試合画面のホームと同じにする。条件を変えると見比べにならない */
const KIT: Voxel.Kit = {
  shirt: "#f2a714", shorts: "#3b2a1b", skin: "#f7cfa4",
  hair: "#3b2a1b", socks: "#f2a714", shoes: "#2b2b33",
};

const POSES: { key: Pose; label: string }[] = [
  { key: "stand", label: "立つ" },
  { key: "run", label: "走る" },
  { key: "sprint", label: "全力" },
  { key: "hold", label: "持つ" },
  { key: "kick", label: "蹴る" },
  { key: "cheer", label: "喜ぶ" },
  { key: "tired", label: "息切れ" },
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
    b.textContent = p.label;
    b.addEventListener("click", () => { pose = p.key; renderPoseRow(); });
    row.append(b);
  }
}

function drawPlayer(t: number): void {
  const cv = $<HTMLCanvasElement>("newCanvas");
  const c = cv.getContext("2d");
  if (c === null) return;
  c.clearRect(0, 0, cv.width, cv.height);

  /* 足元の地面。何も敷かないと、浮いているのか立っているのか分からない */
  c.fillStyle = "#3f9e46";
  c.fillRect(0, 0, cv.width, cv.height);

  const cam: Voxel.Cam = {
    yaw: camYaw,
    pitch: camPitch,
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
    requestAnimationFrame(loop);
    const t = (now - t0) / 1000;
    if (spinning) {
      camYaw = (t * 0.6) % (Math.PI * 2);
      const el = $<HTMLInputElement>("camYaw");
      el.value = String(Math.round((camYaw * 180) / Math.PI));
      $("camYawVal").textContent = fmtDeg(camYaw);
    }
    drawPlayer(t);
  };
  requestAnimationFrame(loop);
}

main();
