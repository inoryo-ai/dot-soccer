/**
 * 試合の再生。右斜め後ろからの見下ろし＋画面中央の下に全体図（ミニマップ）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここは「描くだけ」。試合の規則を1行も書かない
 * ─────────────────────────────────────────────────────────────
 * 位置も得点もすべて `src/sim/` が決めた結果を読むだけにする。
 * ここで「ゴール判定」や「誰が速いか」を書き始めると、エンジンが2つに分かれる。
 *
 * 🔴 **エンジンは平面（x, y）しか持っていない。** ボールの高さも選手の背丈も
 *    計算していない。立体に見えるのはすべて**描き方**で作っている:
 *      ・奥ほど小さく描く（透視投影）
 *      ・足元に影を落とす
 *      ・ゴールに高さを持たせる
 *      ・ボールが飛ぶ間だけ、弧を描いて浮かせる
 *    ここで作った「高さ」を試合の判定に使ってはいけない（エンジンの値ではない）。
 *
 * 🔑 描画には Math.sin などをそのまま使ってよい。ここの値は**画面にしか出ず**、
 *    試合の結果に戻らない（環境ごとの最後のビットの違いが効かない）。
 *
 * 🔑 受け取るのは `api.playNext()` の `replay`:
 *      sample_ticks : 何ティックごとのコマか（1 なら毎秒）
 *      coord_scale  : 座標の倍率（10 なら 0.1m 単位の整数）
 *      pitch        : [横m, 縦m]
 *      roster       : コマの中の番号が誰かの名簿
 *      frames       : [ボールX, ボールY, 保持者の番号, 選手0X, 選手0Y, ...] の配列
 *
 * 🔑 出来事（events）は `{time, tick, type, team, player, detail}`。
 *    **`team` はチーム名の文字列**（番号ではない）。
 */

import type { MatchEvent, Replay } from "../sim/engine.ts";
import * as Sprites from "./sprites.ts";
import type { KitColors } from "./sprites.ts";

/* ---------------------------------------------------------- カメラ設定 */
/* 🔑 「右斜め後ろから見下ろす」を、振り向き（yaw）と見下ろし角（pitch）で表す。
      カメラはボールを追うが、**向きは変えない**。向きまで追うと画面が回って、
      どちらへ攻めているか分からなくなる。 */
const CAM_YAW = -0.52;         // 右へ振る量（ラジアン）
const CAM_PITCH = 0.56;        // 見下ろす角度（0=水平・π/2=真上）
const CAM_DIST = 26;           // 注視点までの距離（m）。小さいほど寄る
const FOCAL = 430;             // 画角。大きいほど寄る

/* 🔑 選手の背丈。18ドットの絵を何メートルとして扱うか。
      実寸（1.8m）どおりだと小さくて読めないので、少し誇張する。
      ここを変えると全員の大きさが変わる（1か所で決める） */
const PLAYER_HEIGHT_M = 2.05;
const CAM_FOLLOW = 0.06;       // カメラがボールに追いつく速さ（1なら即追従）

const PAD_BOTTOM = 62;         // 下の全体図のぶん空ける

const STRIPES = 26;
const PASS_ARC_M = 2.6;        // 飛んでいる間の最大の高さ（m・見た目だけ）
const JUMP_M = 6.0;            // これ以上ボールが動いたら「蹴った」とみなす

/* 🔴 ここの色は `web/style.css` の `:root` と**同じ値にそろえる**（2026-10-02）。
      canvas の色は CSS 変数を読めないので、どうしても二重に書くことになる。
      片方だけ変えると、盤の芝と画面の芝が違う緑になり、それだけで安く見える。
      ずらすのは「盤の中だけで意味がある差」（縞・影）に限る。 */
const COLOR = {
  /* 盤の外側。画面の枠（--edge）と同じ濃茶にして、canvas と枠を地続きに見せる */
  sky: "#3b2a1b",
  /* 🔑 ピッチの外にも芝を敷く。敷かないと画面の端が黒く抜けて、
        ピッチが宙に浮いて見える */
  outfield: "#2e8c46",
  turf: "#3fae5a",          /* = --turf */
  /* 🔑 縞は**質感**であって模様ではない。差を付けすぎると
        斜めの帯に見えて、芝に見えなくなる */
  turfAlt: "#37a04f",       /* = --turf-dark */
  line: "rgba(234, 251, 238, .88)",
  shadow: "rgba(26, 60, 34, .34)",
  ball: "#fffdf3",
  ballEdge: "#3b2a1b",
  goal: "rgba(255, 255, 255, .24)",
  minimapBg: "rgba(59, 42, 27, .86)",
};

type KitKey = "home" | "away" | "gk";
const KIT: Record<KitKey, KitColors> = {
  home: { shirt: "#f2a714", shirtDark: "#c7820a", shorts: "#3b2a1b",
          skin: "#f7cfa4", hair: "#3b2a1b", socks: "#f2a714" },
  away: { shirt: "#3d8ed6", shirtDark: "#2a6ba6", shorts: "#23364a",
          skin: "#f7cfa4", hair: "#2a1f16", socks: "#3d8ed6" },
  gk: { shirt: "#e2574c", shirtDark: "#b23a31", shorts: "#3b2a1b",
        skin: "#f7cfa4", hair: "#3b2a1b", socks: "#e2574c" },
};

/* ピッチの実寸（m）。競技規則の数字で、描き手が作らない */
const PENALTY = { depth: 16.5, width: 40.3 };
const GOAL_AREA = { depth: 5.5, width: 18.3 };
const GOAL = { depth: 2.4, width: 7.32, height: 2.44 };
const CENTER_CIRCLE = 9.15;
const PENALTY_SPOT = 11.0;

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
}

interface Vec3 { x: number; y: number; z: number }
interface Projected { x: number; y: number; scale: number; depth: number }
type Point3 = [number, number, number?];

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let replay: Replay | null = null;
let events: MatchEvent[] = [];
let goalEvents: MatchEvent[] = [];
let homeName = "";

let frameIndex = 0;
let playing = false;
let speed = 1;
let lastStamp = 0;
let rafId = 0;
let onUpdate: ((s: PitchState) => void) | null = null;
let onFinish: (() => void) | null = null;

const camTarget = { x: 52.5, y: 34 };
const phases: number[] = [];       // 選手ごとの足の運びの位相（足並みをそろえない）
const facings: number[] = [];      // 選手ごとの向き

function need<T>(v: T | null, what: string): T {
  if (v === null) throw new Error(`${what} が用意されていない（attach / load を先に呼ぶ）`);
  return v;
}

/* ------------------------------------------------------------ 投影 */

let basis: { eye: Vec3; right: Vec3; up: Vec3; fwd: Vec3 } | null = null;

function buildCamera(tx: number, ty: number): void {
  const cp = Math.cos(CAM_PITCH);
  const sp = Math.sin(CAM_PITCH);
  const cy = Math.cos(CAM_YAW);
  const sy = Math.sin(CAM_YAW);
  const fwd = { x: cp * cy, y: cp * sy, z: -sp };
  const eye = { x: tx - fwd.x * CAM_DIST, y: ty - fwd.y * CAM_DIST, z: -fwd.z * CAM_DIST };
  /* 右手方向 = fwd × 真上(0,0,1) */
  const right = { x: fwd.y, y: -fwd.x, z: 0 };
  const rlen = Math.hypot(right.x, right.y) || 1;
  right.x /= rlen;
  right.y /= rlen;
  /* 上方向 = right × fwd */
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  basis = { eye, right, up, fwd };
}

/** 世界の点（m・z は上）を画面へ。奥にあるほど scale が小さい */
function project(x: number, y: number, z = 0): Projected | null {
  const { eye, right, up, fwd } = need(basis, "カメラ");
  const cv = need(canvas, "canvas");
  const vx = x - eye.x;
  const vy = y - eye.y;
  const vz = z - eye.z;
  const depth = vx * fwd.x + vy * fwd.y + vz * fwd.z;
  if (depth <= 1) return null;          // カメラの後ろは描かない
  const sx = vx * right.x + vy * right.y + vz * right.z;
  const sy = vx * up.x + vy * up.y + vz * up.z;
  const viewH = cv.height - PAD_BOTTOM;
  return {
    x: cv.width / 2 + (FOCAL * sx) / depth,
    y: viewH / 2 - (FOCAL * sy) / depth,
    scale: FOCAL / depth,
    depth,
  };
}

/* ------------------------------------------------------------ 読み込み */

export function attach(canvasEl: HTMLCanvasElement): void {
  canvas = canvasEl;
  ctx = canvas.getContext("2d", { alpha: false });
  if (ctx === null) throw new Error("ピッチを描く canvas が使えない");
  ctx.imageSmoothingEnabled = false;
}

export function load(data: Replay, matchEvents: MatchEvent[], homeTeamName: string,
                     callbacks: PitchCallbacks): void {
  replay = data;
  homeName = homeTeamName;
  events = matchEvents.slice().sort((a, b) => a.tick - b.tick);
  goalEvents = events.filter((e) => e.type === "ゴール");

  phases.length = 0;
  facings.length = 0;
  for (let i = 0; i < data.roster.length; i += 1) {
    /* 🔑 足並みをそろえない。同じ位相で始めると22人が同じ足で走る */
    phases.push((i * 1.7) % 4);
    facings.push(0);
  }
  const k = data.coord_scale;
  const first = data.frames[0]!;
  camTarget.x = first[0]! / k;
  camTarget.y = first[1]! / k;

  frameIndex = 0;
  playing = true;
  onUpdate = callbacks.onUpdate ?? null;
  onFinish = callbacks.onFinish ?? null;
  lastStamp = 0;
  start();
}

/* --------------------------------------------------------------- 進行 */

function start(): void {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(step);
}

function step(stamp: number): void {
  if (replay === null) return;
  if (!lastStamp) lastStamp = stamp;
  const dt = Math.min(0.1, (stamp - lastStamp) / 1000);
  lastStamp = stamp;

  if (playing) {
    /* 🔴 ×1 は実時間（試合の1秒＝実際の1秒）。
       1コマ = sample_ticks 秒ぶんなので、進むコマ数は speed ÷ sample_ticks */
    frameIndex += (dt * speed) / replay.sample_ticks;
    const last = replay.frames.length - 1;
    if (frameIndex >= last) {
      frameIndex = last;
      playing = false;
      if (onFinish) onFinish();
    }
  }

  draw(dt);
  if (onUpdate) onUpdate(state());
  rafId = requestAnimationFrame(step);
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

/* --------------------------------------------------------- 盤面を描く */

const NEAR = 1.2;          // これより手前は描けない（カメラの目の前）

/** その点の「奥行き」。負ならカメラの後ろ */
function depthOf(p: Point3): number {
  const { eye, fwd } = need(basis, "カメラ");
  return (p[0] - eye.x) * fwd.x + (p[1] - eye.y) * fwd.y + ((p[2] ?? 0) - eye.z) * fwd.z;
}

/**
 * 🔴 **カメラの後ろに角がある図形を、丸ごと捨てない。**
 *    以前は角が1つでも後ろにあると描画を諦めていたので、
 *    芝の縞が虫食いになり、地面が黒く抜けてピッチが宙に浮いて見えた。
 *    手前の面（NEAR）で**切り取ってから**投影する。
 */
function clipNear(points: Point3[]): Point3[] {
  const out: Point3[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const da = depthOf(a) - NEAR;
    const db = depthOf(b) - NEAR;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t,
                a[1] + (b[1] - a[1]) * t,
                (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * t]);
    }
  }
  return out;
}

function fillPoly(points3: Point3[], color: string): void {
  const c = need(ctx, "描画");
  const clipped = clipNear(points3);
  if (clipped.length < 3) return;
  const pts = clipped.map((p) => project(p[0], p[1], p[2]));
  if (pts.some((p) => p === null)) return;
  const ps = pts as Projected[];
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(ps[0]!.x, ps[0]!.y);
  for (let i = 1; i < ps.length; i += 1) c.lineTo(ps[i]!.x, ps[i]!.y);
  c.closePath();
  c.fill();
}

/** 折れ線。手前で切れたところは分けて描く（線をつなげると画面を横切る） */
function strokeLine(points3: Point3[]): void {
  const c = need(ctx, "描画");
  let run: Projected[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      c.beginPath();
      c.moveTo(run[0]!.x, run[0]!.y);
      for (let i = 1; i < run.length; i += 1) c.lineTo(run[i]!.x, run[i]!.y);
      c.stroke();
    }
    run = [];
  };
  for (const p of points3) {
    if (depthOf(p) <= NEAR) {
      flush();
      continue;
    }
    const q = project(p[0], p[1], p[2]);
    if (q === null) {
      flush();
      continue;
    }
    run.push(q);
  }
  flush();
}

function box(x: number, y: number, w: number, h: number): void {
  strokeLine([[x, y, 0], [x + w, y, 0], [x + w, y + h, 0], [x, y + h, 0], [x, y, 0]]);
}

function drawField(px: number, py: number): void {
  const c = need(ctx, "描画");
  const cv = need(canvas, "canvas");
  c.fillStyle = COLOR.sky;
  c.fillRect(0, 0, cv.width, cv.height);

  /* 🔑 見下ろしているので、画面はすべて地面。地平線は画面の上に外れている。
     先に一面を外の芝で塗っておけば、ピッチの外が黒く抜けない */
  c.fillStyle = COLOR.outfield;
  c.fillRect(0, 0, cv.width, cv.height);

  fillPoly([[0, 0, 0], [px, 0, 0], [px, py, 0], [0, py, 0]], COLOR.turf);
  const sw = px / STRIPES;
  for (let i = 0; i < STRIPES; i += 2) {
    fillPoly([[i * sw, 0, 0], [(i + 1) * sw, 0, 0],
              [(i + 1) * sw, py, 0], [i * sw, py, 0]], COLOR.turfAlt);
  }

  c.strokeStyle = COLOR.line;
  c.lineWidth = 1;
  box(0, 0, px, py);
  strokeLine([[px / 2, 0, 0], [px / 2, py, 0]]);

  /* 円は分割して折れ線で描く（透視で歪むので2点では足りない） */
  const circle: Point3[] = [];
  for (let i = 0; i <= 32; i += 1) {
    const t = (i / 32) * Math.PI * 2;
    circle.push([px / 2 + Math.cos(t) * CENTER_CIRCLE, py / 2 + Math.sin(t) * CENTER_CIRCLE, 0]);
  }
  strokeLine(circle);

  for (const left of [true, false]) {
    box(left ? 0 : px - PENALTY.depth, (py - PENALTY.width) / 2, PENALTY.depth, PENALTY.width);
    box(left ? 0 : px - GOAL_AREA.depth, (py - GOAL_AREA.width) / 2,
        GOAL_AREA.depth, GOAL_AREA.width);
    const spot = project(left ? PENALTY_SPOT : px - PENALTY_SPOT, py / 2, 0);
    if (spot) {
      c.fillStyle = COLOR.line;
      c.fillRect(spot.x - 1, spot.y - 1, 2, 2);
    }

    /* ゴールは**高さを持たせる**。ここが一番「立体」に見える */
    const gx = left ? 0 : px;
    const dir = left ? -1 : 1;
    const y0 = (py - GOAL.width) / 2;
    const y1 = y0 + GOAL.width;
    const h = GOAL.height;
    fillPoly([[gx, y0, 0], [gx, y1, 0], [gx, y1, h], [gx, y0, h]], COLOR.goal);
    strokeLine([[gx, y0, 0], [gx, y0, h], [gx, y1, h], [gx, y1, 0]]);
    strokeLine([[gx, y0, h], [gx + dir * GOAL.depth, y0, h]]);
    strokeLine([[gx, y1, h], [gx + dir * GOAL.depth, y1, h]]);
  }
}

/* --------------------------------------------- ボールの高さ（見た目だけ） */

function ballHeight(rp: Replay, a: number, b: number, t: number, k: number): number {
  const fa = rp.frames[a]!;
  const fb = rp.frames[b]!;
  const jump = Math.hypot(fb[0]! / k - fa[0]! / k, fb[1]! / k - fa[1]! / k);
  if (jump < JUMP_M) return 0;
  /* 🔑 エンジンはボールを受け手の足元へ**瞬間移動**させる（高さを持たないため）。
     寄った画面ではそこが一番不自然に見えるので、飛んでいる間だけ弧を描く。
     見た目だけで、判定には一切関わらない。 */
  return Math.sin(Math.PI * t) * Math.min(PASS_ARC_M, PASS_ARC_M * (jump / 30));
}

/* ------------------------------------------------------------ 本体 */

function draw(dt: number): void {
  const rp = need(replay, "再生データ");
  const c = need(ctx, "描画");
  const k = rp.coord_scale;
  const a = Math.floor(frameIndex);
  const b = Math.min(a + 1, rp.frames.length - 1);
  const t = frameIndex - a;
  const fa = rp.frames[a]!;
  const fb = rp.frames[b]!;
  const lerp = (i: number): number => (fa[i]! + (fb[i]! - fa[i]!) * t) / k;

  const [px, py] = rp.pitch;

  const bx = lerp(0);
  const by = lerp(1);
  const follow = Math.min(1, CAM_FOLLOW * (dt * 60));
  camTarget.x += (bx - camTarget.x) * follow;
  camTarget.y += (by - camTarget.y) * follow;
  buildCamera(camTarget.x, camTarget.y);

  drawField(px, py);

  const roster = rp.roster;
  const owner = fa[2];
  const list: { i: number; p: Projected; sp: number }[] = [];
  for (let i = 0; i < roster.length; i += 1) {
    const x = lerp(3 + i * 2);
    const y = lerp(4 + i * 2);
    const p0 = project(x, y, 0);
    if (!p0) continue;

    const dx = (fb[3 + i * 2]! - fa[3 + i * 2]!) / k;
    const dy = (fb[4 + i * 2]! - fa[4 + i * 2]!) / k;
    const sp = Math.hypot(dx, dy) / rp.sample_ticks;      // m/s
    if (sp > 0.25) {
      /* 🔑 絵の向きは**画面の上での向き**で選ぶ。世界の向きで選ぶと、
         カメラを振っている今の見え方と合わない */
      const p1 = project(x + dx, y + dy, 0);
      if (p1) facings[i] = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }
    phases[i] = (phases[i]! + sp * dt * 2.4) % Sprites.RUN_FRAMES;
    list.push({ i, p: p0, sp });
  }
  /* 奥から順に描く（手前が上に重なる） */
  list.sort((m, n) => n.p.depth - m.p.depth);

  for (const { i, p, sp } of list) {
    const who = roster[i]!;
    const kitKey: KitKey = who.pos === "GK" ? "gk" : (who.team === 0 ? "home" : "away");
    const kit = KIT[kitKey];

    const sx = p.scale * 0.55;
    c.fillStyle = COLOR.shadow;
    c.beginPath();
    c.ellipse(p.x, p.y, Math.max(1.5, sx * 0.9), Math.max(0.8, sx * 0.4), 0, 0, Math.PI * 2);
    c.fill();

    const moving = sp > 0.6;
    const frame = Math.floor(phases[i]!) % Sprites.RUN_FRAMES;
    const img = Sprites.get(kitKey, kit, Sprites.dirOf(facings[i]!), frame, moving);
    /* 1ドットの大きさ。奥ほど小さい */
    const unit = Math.max(0.9, (p.scale * PLAYER_HEIGHT_M) / Sprites.H);
    const w = Sprites.W * unit;
    const h = Sprites.H * unit;
    c.drawImage(img, Math.round(p.x - w / 2), Math.round(p.y - Sprites.FEET_Y * unit),
                Math.round(w), Math.round(h));

    if (i === owner) {
      c.strokeStyle = "#ffffff";
      c.lineWidth = 1;
      c.beginPath();
      c.ellipse(p.x, p.y, Math.max(2.5, sx * 1.3), Math.max(1.2, sx * 0.6), 0, 0, Math.PI * 2);
      c.stroke();
    }
  }

  const height = ballHeight(rp, a, b, t, k);
  const ground = project(bx, by, 0);
  const air = project(bx, by, height);
  if (ground) {
    c.fillStyle = COLOR.shadow;
    c.beginPath();
    c.ellipse(ground.x, ground.y, Math.max(1.2, ground.scale * 0.03),
              Math.max(0.6, ground.scale * 0.015), 0, 0, Math.PI * 2);
    c.fill();
  }
  if (air) {
    const r = Math.max(1.8, air.scale * 0.14);          // ボールの半径 約0.14m相当
    c.fillStyle = COLOR.ballEdge;
    c.beginPath();
    c.arc(air.x, air.y, r + 1, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = COLOR.ball;
    c.beginPath();
    c.arc(air.x, air.y, r, 0, Math.PI * 2);
    c.fill();
  }

  drawMinimap(rp, px, py, fa, fb, t, k);
}

/* --------------------------------------------- 全体図（画面中央の一番下） */

function drawMinimap(rp: Replay, px: number, py: number, fa: number[], fb: number[],
                     t: number, k: number): void {
  const c = need(ctx, "描画");
  const cv = need(canvas, "canvas");
  const mw = Math.min(160, cv.width * 0.36);
  const mh = mw * (py / px);
  const mx = (cv.width - mw) / 2;
  const my = cv.height - mh - 6;

  c.fillStyle = COLOR.minimapBg;
  c.fillRect(mx - 3, my - 3, mw + 6, mh + 6);
  c.fillStyle = COLOR.turf;
  c.fillRect(mx, my, mw, mh);
  c.strokeStyle = "rgba(232,248,238,.5)";
  c.lineWidth = 1;
  c.strokeRect(mx + 0.5, my + 0.5, mw - 1, mh - 1);
  c.beginPath();
  c.moveTo(Math.round(mx + mw / 2) + 0.5, my);
  c.lineTo(Math.round(mx + mw / 2) + 0.5, my + mh);
  c.stroke();

  const at = (x: number, y: number): { x: number; y: number } =>
    ({ x: mx + (x / px) * mw, y: my + (y / py) * mh });
  const lerp = (i: number): number => (fa[i]! + (fb[i]! - fa[i]!) * t) / k;

  for (let i = 0; i < rp.roster.length; i += 1) {
    const who = rp.roster[i]!;
    const q = at(lerp(3 + i * 2), lerp(4 + i * 2));
    c.fillStyle = who.pos === "GK" ? KIT.gk.shirt : (who.team === 0 ? KIT.home.shirt : KIT.away.shirt);
    c.fillRect(Math.round(q.x) - 1, Math.round(q.y) - 1, 3, 3);
  }
  const ball = at(lerp(0), lerp(1));
  c.fillStyle = "#ffffff";
  c.fillRect(Math.round(ball.x) - 1, Math.round(ball.y) - 1, 2, 2);

  /* いまカメラが見ているあたり。全体のどこを見ているかが分かるようにする */
  const cam = at(camTarget.x, camTarget.y);
  c.strokeStyle = "rgba(255,255,255,.6)";
  c.strokeRect(Math.round(cam.x) - 15, Math.round(cam.y) - 10, 30, 20);
}

/* --------------------------------------------------------------- 操作 */

export function toggle(): boolean {
  playing = !playing;
  lastStamp = 0;
  return playing;
}

export function setSpeed(v: number): number {
  speed = v;
  return speed;
}

export function skipToEnd(): void {
  const rp = need(replay, "再生データ");
  frameIndex = rp.frames.length - 1;
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
