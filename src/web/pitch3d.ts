/**
 * サッカー場を3Dで再生する検証ページ（`web/pitch3d.html`）。
 *
 * 🔴 **本物の試合データをそのまま再生する。** 適当に動かした絵では、
 *    「3Dが良いのか、動きを都合よく作ったのか」が区別できない。
 *    いまの試合画面とまったく同じリプレイを、描き方だけ変えて見せる。
 *
 * 🔴 ここもゲームの規則を1行も持たない。`src/sim/` が出した結果を並べるだけ。
 */

import { play } from "../sim/engine.ts";
import type { Replay } from "../sim/engine.ts";
import { buildPreset } from "../sim/presets.ts";
import * as Field from "./field3d.ts";
import * as Stadium from "./stadium3d.ts";
import * as Voxel from "./voxel.ts";
import type { Pose } from "./voxel.ts";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`検証画面に #${id} が無い`);
  return n as T;
}

/* 🔑 色は試合画面と同じ。条件を変えると比較にならない */
const KITS: Record<string, Voxel.Kit> = {
  home: { shirt: "#f2a714", shorts: "#3b2a1b", skin: "#f7cfa4",
          hair: "#3b2a1b", socks: "#f2a714", shoes: "#2b2b33" },
  away: { shirt: "#3d8ed6", shorts: "#23364a", skin: "#f7cfa4",
          hair: "#2a1f16", socks: "#3d8ed6", shoes: "#2b2b33" },
  gk:   { shirt: "#e2574c", shorts: "#3b2a1b", skin: "#f7cfa4",
          hair: "#3b2a1b", socks: "#e2574c", shoes: "#2b2b33" },
};

/* 🗑 2026-10-03: ここにあった `SPRINT_MS = 5.2` を消した。
      姿勢の境目は `voxel.ts` の `pickPose` が1か所で持つ。 */

let replay: Replay | null = null;
let frameIndex = 0;
let playing = true;
let speed = 1;
let follow = true;
/* 🔑 2026-10-03 オーナー判断「角度90・見下ろし40・引き20がちょうどいい」 */
let camYaw = Math.PI / 2;
let camPitch = (40 * Math.PI) / 180;
let camDist = 20;

/* ボールの転がり。**進んだ距離**から出す（時間で回すと止まっても回り続ける） */
let ballSpin = 0;
let ballDir = 0;
let ballPrev: { x: number; y: number } | null = null;
let showNames = true;

/* 選手ごとの向きと足の位相（足並みをそろえない） */
const facings: number[] = [];
const phases: number[] = [];

function buildMatch(): void {
  /* 🔑 第5引数 record=true でコマが残る。log は要らないので false */
  const r = play(buildPreset("バランス型"), buildPreset("プレス型"), 1000, false, true);
  replay = (r as { replay: Replay }).replay;
  facings.length = 0;
  phases.length = 0;
  for (let i = 0; i < replay.roster.length; i++) {
    facings.push(0);
    phases.push(i * 0.37);
  }
}

/** 観客の揺れに使う秒数。試合の再生とは別に進める（止めても観客は動く） */
let clock = 0;

function drawFrame(dt: number): void {
  clock += dt;
  const rp = replay;
  if (rp === null) return;
  const cv = $<HTMLCanvasElement>("view3d");
  const c = cv.getContext("2d");
  if (c === null) return;

  const last = rp.frames.length - 1;
  if (playing) frameIndex = Math.min(last, frameIndex + (dt * speed) / (rp.sample_ticks * rp.tick_s) * 60);
  const a = Math.floor(frameIndex);
  const bIdx = Math.min(last, a + 1);
  const t = frameIndex - a;
  const fa = rp.frames[a]!;
  const fb = rp.frames[bIdx]!;
  const k = rp.coord_scale;
  const lerp = (i: number): number => (fa[i]! + (fb[i]! - fa[i]!) * t) / k;

  const bx = lerp(0);
  const by = lerp(1);
  const owner = fa[2]!;

  const target = follow
    ? { x: bx, y: by, z: 0 }
    : { x: Field.PITCH_X / 2, y: Field.PITCH_Y / 2, z: 0 };
  const cam: Voxel.Cam = {
    yaw: camYaw, pitch: camPitch, dist: camDist, focal: 520,
    target, cx: cv.width / 2, cy: cv.height * 0.56,
  };

  /* 🔴 空 → 観客席 → ピッチ の順。観客席はピッチの外なので重ならないが、
        屋根と照明塔は空へ伸びるので、空より後・ピッチより先に描く必要がある。 */
  Stadium.draw(c, cam, clock);
  Field.draw(c, cam);

  /* 🔴 奥から手前へ。カメラからの距離で並べ替えてから描く */
  const list: { i: number; x: number; y: number; sp: number; d: number }[] = [];
  for (let i = 0; i < rp.roster.length; i++) {
    const x = lerp(3 + i * 2);
    const y = lerp(4 + i * 2);
    const dx = (fb[3 + i * 2]! - fa[3 + i * 2]!) / k;
    const dy = (fb[4 + i * 2]! - fa[4 + i * 2]!) / k;
    const sp = Math.hypot(dx, dy) / (rp.sample_ticks * rp.tick_s);
    if (sp > 0.25) facings[i] = Math.atan2(dy, dx);
    /* 🔴 **実際の秒数で進める。** `voxel.ts` の姿勢は秒を前提に周期を書いている。
          進んだ距離で進めると、止まっている選手は呼吸も止まる。 */
    phases[i] = (phases[i]! + dt) % 1000;
    const vx = x - (target.x - Math.cos(camYaw) * camDist);
    const vy = y - (target.y - Math.sin(camYaw) * camDist);
    list.push({ i, x, y, sp, d: Math.hypot(vx, vy) });
  }
  list.sort((m, n) => n.d - m.d);

  for (const { i, x, y, sp } of list) {
    const who = rp.roster[i]!;
    const kit = KITS[who.pos === "GK" ? "gk" : (who.team === 0 ? "home" : "away")]!;
    /* 🔴 姿勢の境目をここに持たない。`pickPose` の1か所だけに置く */
    const pose: Pose = Voxel.pickPose({ speed: sp, hasBall: i === owner });
    const at = { x, y, z: 0 };
    Voxel.drawShadow(c, cam, at);
    Voxel.drawPlayer(c, cam, { at, facing: facings[i]!, pose, t: phases[i]!, kit });

    if (showNames) {
      /* 🔑 名前は**頭の上**に出す。足元だと選手の体で隠れる */
      const h = Voxel.headTop(cam, at);
      if (h !== null) {
        c.font = "bold 12px system-ui, sans-serif";
        c.textAlign = "center";
        c.lineWidth = 3;
        c.strokeStyle = "rgba(20, 40, 70, .85)";
        c.strokeText(who.name, h.x, h.y - 8);
        c.fillStyle = "#ffffff";
        c.fillText(who.name, h.x, h.y - 8);
        c.textAlign = "left";
      }
    }
  }

  /* 🔑 転がり量＝進んだ距離 ÷ 半径。向きも進行方向から取る。
        止まれば回転も止まるので「転がっている」ように見える。 */
  if (ballPrev !== null) {
    const dx = bx - ballPrev.x;
    const dy = by - ballPrev.y;
    const moved = Math.hypot(dx, dy);
    if (moved > 0.01) {
      ballDir = Math.atan2(dy, dx);
      ballSpin = (ballSpin + moved / 0.30) % (Math.PI * 2);
    }
  }
  ballPrev = { x: bx, y: by };
  Field.drawBall(c, cam, { x: bx, y: by, z: 0.30 }, ballSpin, ballDir);

  const sec = Math.round(frameIndex * rp.sample_ticks * rp.tick_s);
  $("clock").textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function main(): void {
  buildMatch();

  const bind = (id: string, valId: string, set: (v: number) => void,
                fmt: (v: number) => string): void => {
    const el = $<HTMLInputElement>(id);
    const out = $(valId);
    const apply = (): void => { set(Number(el.value)); out.textContent = fmt(Number(el.value)); };
    el.addEventListener("input", apply);
    apply();
  };
  bind("camYaw", "camYawVal", (v) => { camYaw = (v * Math.PI) / 180; }, (v) => `${v}°`);
  bind("camPitch", "camPitchVal", (v) => { camPitch = (v * Math.PI) / 180; }, (v) => `${v}°`);
  bind("camDist", "camDistVal", (v) => { camDist = v; }, (v) => `${v}m`);
  bind("speed", "speedVal", (v) => { speed = v / 100; }, (v) => `${(v / 100).toFixed(1)}x`);

  $("playBtn").addEventListener("click", () => {
    playing = !playing;
    $("playBtn").textContent = playing ? "一時停止" : "再生";
  });
  $("followBtn").addEventListener("click", () => {
    follow = !follow;
    $("followBtn").textContent = follow ? "ボールを追う: オン" : "ボールを追う: オフ";
  });
  $("namesBtn").addEventListener("click", () => {
    showNames = !showNames;
    $("namesBtn").textContent = showNames ? "名前: 出す" : "名前: 消す";
  });
  $("rewindBtn").addEventListener("click", () => { frameIndex = 0; });

  let prev = performance.now();
  const loop = (now: number): void => {
    /* 🔴 **経過時間は負にならない**ようにする。requestAnimationFrame が渡す時刻は
          「そのコマが始まった時刻」なので、`main()` で読んだ `performance.now()` より
          **前**になることがある。すると1コマ目だけ `dt` が負になり、`frameIndex` が
          -1 になって `frames[-1]` で落ちた（2026-10-03 に実際に発生）。 */
    const dt = Math.max(0, Math.min(0.1, (now - prev) / 1000));
    prev = now;
    /* 🔴 **次のコマの予約を先にする。** 後ろに置くと、描画で1回でも例外が出た瞬間に
          予約まで到達せず**ループが静かに止まる**（画面は真っ白のまま、
          エラーも流れない）。実際にこれで止まって原因が分からなかった。 */
    requestAnimationFrame(loop);
    try {
      drawFrame(dt);
    } catch (e) {
      /* 握りつぶさない。検証ページなので画面に出す */
      const box = $("err");
      box.hidden = false;
      box.textContent = `描画で失敗: ${e instanceof Error ? `${e.message}\n${e.stack ?? ""}`
                                                          : String(e)}`;
    }
  };
  requestAnimationFrame(loop);
}

main();
