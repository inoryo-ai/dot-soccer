/**
 * 試合の描画（3D）— **これが唯一の試合描画**（2026-10-03 オーナー判断で一本化）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ2Dドット絵をやめたのか
 * ─────────────────────────────────────────────────────────────
 * 2Dは `8方向 × 4コマ × 姿勢の数` を手で描く。姿勢を1つ足すたびに
 * **8方向ぶん全部**描き直すので、動きの数に比例して費用が増えた。
 * だから「蹴る」も「競る」も入らないまま止まっていた。
 *
 * 3Dは**モデル1体・向きは投影が出す・動きは関節を回すだけ**。
 * 2本持つと同じ直しを2回やることになるので、2Dは捨てた
 * （`pitch.ts` / `sprites.ts` を削除。経緯は D-33）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 外から見える形は前のまま
 * ─────────────────────────────────────────────────────────────
 * `attach` / `attachMini` / `fit` / `load` / `state` / `toggle` / `setSpeed` /
 * `skipToEnd` / `pause` / `resume` / `stop`。
 * 画面（`main.ts`）はこれしか触っていないので、**中身だけ入れ替わる**。
 *
 * 🔴 ここもゲームの規則を1行も持たない。`src/sim/` が出したコマを並べるだけ。
 */

import * as C from "../sim/constants.ts";
import type { MatchEvent, Replay } from "../sim/engine.ts";
import * as Field from "./field3d.ts";
import * as Stadium from "./stadium3d.ts";
import * as Voxel from "./voxel.ts";
import type { Pose } from "./voxel.ts";

export interface PitchState {
  tick: number;
  home: number;
  away: number;
  event: MatchEvent | null;
  done: boolean;
}

export interface PitchCallbacks {
  onUpdate?: (s: PitchState) => void;
  onFinish?: () => void;
  /** 前半が終わった瞬間に1回だけ。呼ばれた時点で再生は止まっている */
  onHalfTime?: () => void;
}

/* 🔑 色は盤の読みやすさで決める。ホーム＝黄／アウェー＝青で固定し、
      自分のチームがどちらかは名前の★で示す（色まで入れ替えると盤が読めない） */
const KIT: Record<string, Voxel.Kit> = {
  home: { shirt: "#f2a714", shorts: "#3b2a1b", skin: "#f7cfa4",
          hair: "#3b2a1b", socks: "#f2a714", shoes: "#2b2b33" },
  away: { shirt: "#3d8ed6", shorts: "#23364a", skin: "#f7cfa4",
          hair: "#2a1f16", socks: "#3d8ed6", shoes: "#2b2b33" },
  gk:   { shirt: "#e2574c", shorts: "#3b2a1b", skin: "#f7cfa4",
          hair: "#3b2a1b", socks: "#e2574c", shoes: "#2b2b33" },
};

/** これより速ければ全力（m/s） */
const SPRINT_MS = 5.2;

/* 🔑 2026-10-03 オーナー判断「角度90・見下ろし40・引き20がちょうどいい」 */
const CAM = { yaw: Math.PI / 2, pitch: (40 * Math.PI) / 180, dist: 20, focal: 520 };

/** カメラがボールを追う速さ。1に近いほど即座に追う（硬すぎると酔う） */
const FOLLOW = 3.2;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let mini: HTMLCanvasElement | null = null;

let replay: Replay | null = null;
let events: MatchEvent[] = [];
let goalEvents: MatchEvent[] = [];
let homeName = "";

let frameIndex = 0;
let playing = false;
let speed = 1;
let lastStamp = 0;
let rafId = 0;
let clock = 0;                      // 観客の揺れ用。再生を止めても進む

let onUpdate: ((s: PitchState) => void) | null = null;
let onFinish: (() => void) | null = null;
let onHalfTime: (() => void) | null = null;
let halfFrame = 0;
let halfPassed = false;

/* 選手ごとの向きと足の位相（足並みをそろえない） */
const facings: number[] = [];
const phases: number[] = [];

/* カメラの注視点。ボールへ滑らかに寄る */
const look = { x: C.PITCH_X / 2, y: C.PITCH_Y / 2 };

/* ボールの転がり。**進んだ距離**から出す（時間で回すと止まっても回り続ける） */
let ballSpin = 0;
let ballDir = 0;
let ballPrev: { x: number; y: number } | null = null;

function need<T>(v: T | null, what: string): T {
  if (v === null) throw new Error(`${what}がまだ無い`);
  return v;
}

/* ------------------------------------------------------------ 取り付け */

export function attachMini(canvasEl: HTMLCanvasElement): void {
  mini = canvasEl;
}

export function attach(canvasEl: HTMLCanvasElement): void {
  canvas = canvasEl;
  const c = canvas.getContext("2d", { alpha: false });
  if (c === null) throw new Error("試合を描く canvas が使えない");
  ctx = c;
  fit();
  globalThis.addEventListener("resize", fit);
}

/**
 * 画面に合わせて盤の大きさを決める。
 *
 * 🔴 2Dのときと**考え方が違う**。ドット絵は「整数倍でないと縞がムラになる」ので
 *    整数倍に限っていたが、3Dにはドットの格子が無い。
 *    **出す場所の実寸そのままで描く**のが一番きれいで、拡大のぼけも出ない。
 * 🔑 画素密度の高い画面では2倍まで上げる。3倍以上は塗る量が増えるだけで見た目が変わらない。
 */
export function fit(): void {
  const cv = canvas;
  if (cv === null) return;
  const box = cv.getBoundingClientRect();
  if (box.width < 1) return;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = Math.round(box.width * dpr);
  const h = Math.round(box.height * dpr);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
}

/* ------------------------------------------------------------ 読み込み */

export function load(data: Replay, matchEvents: MatchEvent[], homeTeamName: string,
                     callbacks: PitchCallbacks): void {
  replay = data;
  homeName = homeTeamName;
  events = matchEvents.slice().sort((a, b) => a.tick - b.tick);
  goalEvents = events.filter((e) => e.type === "ゴール");

  facings.length = 0;
  phases.length = 0;
  for (let i = 0; i < data.roster.length; i++) {
    facings.push(0);
    /* 🔑 足並みをそろえない。同じ位相で始めると22人が同じ足で走る */
    phases.push((i * 1.7) % 4);
  }

  const k = data.coord_scale;
  const first = data.frames[0]!;
  look.x = first[0]! / k;
  look.y = first[1]! / k;
  ballPrev = null;
  ballSpin = 0;
  ballDir = 0;

  frameIndex = 0;
  playing = true;
  /* 🔑 前半の終わりは**規則の層の数字**から出す。ここに 2700 と書くと、
        試合の長さを変えたときに演出だけ前半のままずれる */
  halfFrame = C.TICKS_PER_HALF / data.sample_ticks;
  halfPassed = false;
  onUpdate = callbacks.onUpdate ?? null;
  onFinish = callbacks.onFinish ?? null;
  onHalfTime = callbacks.onHalfTime ?? null;
  lastStamp = 0;
  fit();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(step);
}

/* -------------------------------------------------------------- 進行 */

function step(stamp: number): void {
  if (replay === null) return;
  if (!lastStamp) lastStamp = stamp;
  /* 🔴 経過時間は負にしない。requestAnimationFrame が渡す時刻は
        「そのコマが始まった時刻」なので、直前に読んだ `performance.now()` より
        前になることがある（3Dの検証ページで実際に落ちた） */
  const dt = Math.max(0, Math.min(0.1, (stamp - lastStamp) / 1000));
  lastStamp = stamp;
  clock += dt;

  if (playing) {
    /* 🔴 ×1 は実時間（試合の1秒＝実際の1秒）。
          1コマ = sample_ticks 秒ぶんなので、進むコマ数は speed ÷ sample_ticks */
    frameIndex += (dt * speed) / replay.sample_ticks;
    const last = replay.frames.length - 1;
    /* 🔴 前半の終わりの判定を**試合終了より先に**置く。後ろに置くと、
          速さを上げたときに1コマで両方を跨いで、ハーフタイムが飛ぶ。 */
    if (!halfPassed && frameIndex >= halfFrame) {
      frameIndex = halfFrame;
      halfPassed = true;
      playing = false;
      if (onHalfTime) onHalfTime();
    } else if (frameIndex >= last) {
      frameIndex = last;
      playing = false;
      if (onFinish) onFinish();
    }
  }

  /* 🔴 次のコマの予約を**先に**する。後ろに置くと、描画で1回でも例外が出た瞬間に
        予約まで到達せずループが静かに止まる（画面は固まったまま、エラーも流れない）。 */
  rafId = requestAnimationFrame(step);
  draw(dt);
  if (onUpdate) onUpdate(state());
}

export function state(): PitchState {
  const tick = Math.round(frameIndex * need(replay, "再生データ").sample_ticks);
  let home = 0;
  let away = 0;
  for (const g of goalEvents) {
    if (g.tick > tick) break;
    if (g.team === homeName) home += 1;
    else away += 1;
  }
  let latest: MatchEvent | null = null;
  for (const e of events) {
    if (e.tick > tick) break;
    latest = e;
  }
  return { tick, home, away, event: latest, done: !playing };
}

/* -------------------------------------------------------------- 描く */

function draw(dt: number): void {
  const rp = replay;
  const cv = canvas;
  const c = ctx;
  if (rp === null || cv === null || c === null) return;

  const last = rp.frames.length - 1;
  const a = Math.max(0, Math.min(last, Math.floor(frameIndex)));
  const bIdx = Math.min(last, a + 1);
  const t = frameIndex - a;
  const fa = rp.frames[a]!;
  const fb = rp.frames[bIdx]!;
  const k = rp.coord_scale;
  const lerp = (i: number): number => (fa[i]! + (fb[i]! - fa[i]!) * t) / k;

  const bx = lerp(0);
  const by = lerp(1);
  const owner = fa[2]!;

  /* 🔑 カメラは**遅れてボールへ寄る**。すぐ張り付くと、速いパスのたびに
        画面全体が跳ねて何が起きたか読めない */
  const ease = 1 - Math.exp(-FOLLOW * dt);
  look.x += (bx - look.x) * ease;
  look.y += (by - look.y) * ease;

  const cam: Voxel.Cam = {
    yaw: CAM.yaw, pitch: CAM.pitch, dist: CAM.dist,
    /* 盤が横に広いほど画角を広げる。狭い窓で寄りすぎると足元しか見えない */
    focal: CAM.focal * (cv.width / 1280),
    target: { x: look.x, y: look.y, z: 0 },
    cx: cv.width / 2,
    cy: cv.height * 0.56,
  };

  /* 🔴 空 → 観客席 → ピッチ の順。屋根と照明塔は空へ伸びるので、
        空より後・ピッチより先に描く必要がある */
  Stadium.draw(c, cam, clock);
  Field.draw(c, cam);

  /* 🔴 奥から手前へ。カメラからの距離で並べ替えてから描く */
  const list: { i: number; x: number; y: number; sp: number; d: number }[] = [];
  const eyeX = look.x - Math.cos(CAM.yaw) * CAM.dist;
  const eyeY = look.y - Math.sin(CAM.yaw) * CAM.dist;
  for (let i = 0; i < rp.roster.length; i++) {
    const x = lerp(3 + i * 2);
    const y = lerp(4 + i * 2);
    const dx = (fb[3 + i * 2]! - fa[3 + i * 2]!) / k;
    const dy = (fb[4 + i * 2]! - fa[4 + i * 2]!) / k;
    const sp = Math.hypot(dx, dy) / rp.sample_ticks;
    if (sp > 0.25) facings[i] = Math.atan2(dy, dx);
    phases[i] = (phases[i]! + sp * dt * 0.9) % 1000;
    list.push({ i, x, y, sp, d: Math.hypot(x - eyeX, y - eyeY) });
  }
  list.sort((m, n) => n.d - m.d);

  for (const { i, x, y, sp } of list) {
    const who = rp.roster[i]!;
    const kit = KIT[who.pos === "GK" ? "gk" : (who.team === 0 ? "home" : "away")]!;
    const pose: Pose = i === owner ? "hold"
                     : sp > SPRINT_MS ? "sprint"
                     : sp > 0.6 ? "run"
                     : "stand";
    const at = { x, y, z: 0 };
    Voxel.drawShadow(c, cam, at);
    Voxel.drawPlayer(c, cam, { at, facing: facings[i]!, pose, t: phases[i]!, kit });
  }

  /* 🔑 転がり量＝進んだ距離 ÷ 半径。止まれば回転も止まる */
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

  drawMinimap(rp, fa, fb, t, k);
}

/**
 * 全体図。**上から見た平面**で、カメラの向きに関わらず同じ向き。
 *
 * 🔑 ここだけは3Dにしない。全体図は「どこで何が起きているか」を一目で見るためのもので、
 *    斜めにすると位置を読むのに頭を使うことになる。
 */
function drawMinimap(rp: Replay, fa: number[], fb: number[], t: number, k: number): void {
  const cv = mini;
  if (cv === null) return;
  const c = cv.getContext("2d");
  if (c === null) return;
  c.clearRect(0, 0, cv.width, cv.height);

  const mw = cv.width - 8;
  const mh = mw * (C.PITCH_Y / C.PITCH_X);
  const mx = 4;
  const my = (cv.height - mh) / 2;

  c.fillStyle = "#14407a";
  c.fillRect(mx - 3, my - 3, mw + 6, mh + 6);
  c.fillStyle = "#3f9e46";
  c.fillRect(mx, my, mw, mh);
  c.strokeStyle = "rgba(232, 248, 238, .5)";
  c.lineWidth = 1;
  c.strokeRect(mx + 0.5, my + 0.5, mw - 1, mh - 1);
  c.beginPath();
  c.moveTo(Math.round(mx + mw / 2) + 0.5, my);
  c.lineTo(Math.round(mx + mw / 2) + 0.5, my + mh);
  c.stroke();

  const at = (x: number, y: number): { x: number; y: number } =>
    ({ x: mx + (x / C.PITCH_X) * mw, y: my + (y / C.PITCH_Y) * mh });
  const lerp = (i: number): number => (fa[i]! + (fb[i]! - fa[i]!) * t) / k;

  for (let i = 0; i < rp.roster.length; i++) {
    const who = rp.roster[i]!;
    const q = at(lerp(3 + i * 2), lerp(4 + i * 2));
    c.fillStyle = who.pos === "GK" ? KIT.gk!.shirt
                : who.team === 0 ? KIT.home!.shirt : KIT.away!.shirt;
    c.fillRect(Math.round(q.x) - 1, Math.round(q.y) - 1, 3, 3);
  }
  const ball = at(lerp(0), lerp(1));
  c.fillStyle = "#ffffff";
  c.fillRect(Math.round(ball.x) - 1, Math.round(ball.y) - 1, 2, 2);
}

/* -------------------------------------------------------------- 操作 */

export function toggle(): boolean {
  playing = !playing;
  lastStamp = 0;
  return playing;
}

/** 演出のあいだ止めておく／演出が終わったら動かす */
export function pause(): void {
  playing = false;
}

export function resume(): void {
  playing = true;
  lastStamp = 0;      // 止めていたあいだの時間を一気に進めない
}

export function setSpeed(v: number): number {
  speed = v;
  return speed;
}

export function skipToEnd(): void {
  const rp = need(replay, "再生データ");
  frameIndex = rp.frames.length - 1;
  /* 🔑 飛ばしたらハーフタイムはもう出さない（終わった試合の途中で割り込まない） */
  halfPassed = true;
  playing = false;
  draw(0.016);
  if (onUpdate) onUpdate(state());
  if (onFinish) onFinish();
}

export function stop(): void {
  cancelAnimationFrame(rafId);
  replay = null;
  playing = false;
}
