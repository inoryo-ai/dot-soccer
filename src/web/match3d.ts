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
 * ─────────────────────────────────────────────────────────────
 * 🔑 カメラの決め方（`distFor` / `focalFor` / `aim`）
 * ─────────────────────────────────────────────────────────────
 * 角度・見下ろし・引きの**基準値はオーナーが見て決めた3つ**（`CAM`）で、動かさない。
 * その上に4つだけ足してある。どれも**指数でゆっくり**効かせる＝画が跳ねると酔う。
 *   1. 引きを場面で変える  — ゴール前は寄り、中盤は引く（`distFor`）
 *   2. 人のかたまりを入れる — 注視点をボールと近くの選手の重心のあいだに置く（`aim`）
 *   3. 窓の縦も見て画角を決める（`focalFor`）
 *   4. 画面の縦（world y）の追従だけ鈍くする（`FOLLOW_Y`／ボールが離れすぎたら `LEASH_FRAC` の綱で引き戻す）
 *
 * 🔴 ここもゲームの規則を1行も持たない。`src/sim/` が出したコマを並べるだけ。
 */

import * as C from "../sim/constants.ts";
import type { MatchEvent, Replay } from "../sim/engine.ts";
import * as Field from "./field3d.ts";
import * as Stadium from "./stadium3d.ts";
import * as Voxel from "./voxel.ts";
import type { Pose } from "./voxel.ts";

/**
 * 再生データに**足してもよい**見た目の情報（新しい試合エンジン `src/sim/match/` が出す・D-42）。
 * 🔑 どちらも省略できる。旧エンジンのリプレイには無いので、無ければ今までどおり
 *    （ボールは地面・姿勢は速さとボールだけで選ぶ）。
 */
export interface ReplayExtras {
  /** コマごとのボールの高さ（地面からの高さ × coord_scale） */
  ballZ?: number[];
  /** 誰が何コマ目に何をしたか。`who` は roster の番号 */
  acts?: ReplayAct[];
}

export interface ReplayAct {
  frame: number;
  who: number;
  act: "kick" | "header" | "tackle" | "down";
}

/**
 * 動作の見せ方（秒）。lead = 当たる瞬間より何秒前から動き出すか、len = 動作の長さ。
 * 🔑 再生データは先まで全部あるので、**当たる瞬間に足（頭）が届くように手前から**動かせる。
 *    lead は voxel.ts の各動作で「当てる」位置（kick 0.44・header 0.45・tackle 0.40）× 周期から出した。
 * 🔑 タックルの周期 1.9秒は、新エンジンの「足を伸ばして、外せば 0.8秒崩れる」に対して長すぎるので、
 *    rate 倍の速さで流して約1秒で終える（滑ったまま 5m/s で走って見えるのを防ぐ）。
 * 🔑 倒れる（反則を受けた）は、再開の準備のあいだ 2秒だけ倒れておく。
 */
const ACT_TIMING: Record<ReplayAct["act"], { lead: number; len: number; rate: number }> = {
  kick:   { lead: 0.44 * 1.15, len: 1.15, rate: 1.0 },
  header: { lead: 0.45 * 1.55, len: 1.55, rate: 1.0 },
  tackle: { lead: 0.40, len: 1.0, rate: 1.9 },   // 当てる位置 0.40 × 周期 1.9秒 ÷ 速さ 1.9
  down:   { lead: 0.0, len: 2.0, rate: 1.0 },
};

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

/* 🗑 2026-10-03: ここにあった `SPRINT_MS = 5.2` を消した。
      姿勢の境目は `voxel.ts` の `pickPose` が1か所で持つ。 */

/* 🔑 2026-10-03 オーナー判断「角度90・見下ろし40・引き20がちょうどいい」。
      **この3つは基準値なので動かさない。** 引きだけは場面で変えるが、
      `dist` は中盤（＝試合のほとんどの時間）の値として残す。 */
const CAM = { yaw: Math.PI / 2, pitch: (40 * Math.PI) / 180, dist: 20, focal: 520 };

/**
 * ゴール前まで来たときの引き（m）。中盤の `CAM.dist` より寄る。
 *
 * 🔑 なぜ寄るのか: ゴール前は1人の体の向きと足の位置が結果を決める場面で、
 *    引いたままだと誰が誰だか分からない。中盤は逆に、どこへ展開するかが見たいので引く。
 */
const DIST_NEAR = 15.5;

/* 寄り始めと引き切りの境目（ゴールラインからの距離・m）。
   🔑 18m ＝ ペナルティエリアの深さ(16.5m)の少し外。ここへ入った時点でもう寄っている。
      34m ＝ ピッチの3分の1。ここより中なら完全に引く。 */
const ZOOM_NEAR_X = 18;
const ZOOM_FAR_X = 34;

/**
 * 引きが目標値へ寄る速さ。
 *
 * 🔴 **注視点より必ず遅くする。** 引きはボールより大きな画の変化なので、
 *    注視点と同じ速さで動かすと、パス1本ごとに画面全体が伸び縮みして酔う。
 */
const ZOOM = 1.1;

/**
 * カメラがボールを追う速さ。1に近いほど即座に追う（硬すぎると酔う）。
 *
 * 🔴 **左右と上下で速さを分ける。** yaw=90° では world x が画面の横・world y が
 *    画面の縦（奥行き）になる。縦を横と同じ速さで追うと、横パスのたびに
 *    地平線ごと上下して落ち着かない。縦だけ鈍くすると画が据わる。
 * 🔴 この x／y の割り当ては **yaw が 90° のときだけ**成り立つ。
 *    角度を振れるようにするなら、カメラの right/fwd に合わせて分解し直すこと。
 */
const FOLLOW_X = 3.2;     // 2026-10-03 までの FOLLOW と同じ値（横の見え方は変えない）
const FOLLOW_Y = 1.7;

/**
 * 縦の「引き綱」。注視点と**ボール**のずれが綱の長さを超えたら、超えたぶんだけ追従を強める。
 *
 * 🔴 **縦をただ鈍くするだけでは駄目。** 見下ろし40°・引き20mだと、注視点より
 *    手前に見えている芝は**11mしかない**（画面の下端まで）。横は24m入るので
 *    多少遅れても画に残るが、縦は 25m/s の大きな展開で遅れが13m まで伸び、
 *    **ボールが画面の下に消える**。鈍さと見失わないことは、強さを一定にすると両立しない。
 * 🔑 強さは連続に変わる（しきい値で切り替えない）ので、綱が効き始めても画は折れない。
 *
 * ── 綱が張り始める離れは、**引きに比例**させる（`LEASH_FRAC` × いまの引き）──
 *
 * 🔴 固定値（6m）だと、寄ったときに前提が壊れる（2026-10-03 のレビューで直した）。
 *    見下ろし40°では、注視点より手前に見える芝は**引きのおよそ 0.55 倍**。
 *    引き20m なら 11m 見えているが、ゴール前で 15.5m まで寄ると **8.5m しか見えない**。
 *    6m のままだと、いちばん寄っている＝いちばん余裕が無い場面で綱が遅れて効く。
 * 🔑 0.30 は「引き20mで 6m」という、もとの目分量をそのまま比に直した数字。
 *    見える芝（0.55×引き）の半分強で張り始める、という意味になる。
 */
const LEASH_FRAC = 0.30;
const LEASH_GAIN = 0.55;

/* 注視点に混ぜる「ボールの近くにいる選手」の範囲（m）と混ぜる割合 */
const CROWD_R = 14;
const CROWD_W = 0.35;

/**
 * 画角を決めるときの基準の窓（px）。
 *
 * 🔑 オーナーが決めた焦点距離 520 は **16:9 の窓**で見て決めた値なので、
 *    16:9 のときに 520×倍率 がそのまま出るように基準を置く。
 */
const REF = { w: 1280, h: 720 };

/** 0..1 に収めて、両端をなめらかにする。境目で寄り方が折れるのを防ぐ */
function smooth01(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let mini: HTMLCanvasElement | null = null;

let replay: (Replay & ReplayExtras) | null = null;
/** 選手ごとの動作（時刻の順）。dir は蹴った・当てたボールの向き（無ければ null） */
let actsOf: { start: number; act: ReplayAct["act"]; dir: number | null }[][] = [];
let events: MatchEvent[] = [];
let goalEvents: MatchEvent[] = [];
let homeName = "";

let frameIndex = 0;
let playing = false;
let speed = 1;
let lastStamp = 0;
let rafId = 0;
let clock = 0;                      // 観客の揺れ用。再生を止めても進む

/** 観客の盛り上がり（0〜1）。得点で 1 になり、ゆっくり冷める */
let excite = 0;
/** 冷めきるまでの秒数 */
const EXCITE_FADE = 7;

/**
 * 観客を沸かせる。**得点した瞬間に画面側から呼ぶ。**
 *
 * 🔑 ここに「いつ沸くか」の判定を置かない。得点を知っているのは画面（`main.ts`）で、
 *    描画は言われたとおり沸くだけ。判定を両方に置くと、片方を直したときにずれる。
 */
export function cheer(): void {
  excite = 1;
}

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

/**
 * 注視点の高さ（m）。浮いたボールの高さの LOOK_Z_FRAC 倍へ、LOOK_Z_FOLLOW の速さで寄る。
 * 🔴 見下ろし40°・引き20m だと、注視点の真上 7m 付近で画面の上端に届く。ロングボールは 10m を超えるので、
 *    地面だけを見ているとボールが画面の上へ消える（2026-10-05 に新エンジンで確認）。
 * 🔑 半分だけ追う。全部追うと、ボールが上がるたびに芝ごと画面が上下して酔う。
 */
let lookZ = 0;
const LOOK_Z_FRAC = 0.5;
const LOOK_Z_FOLLOW = 2.0;

/* いまの引き。目標（場面で決まる値）へ滑らかに寄る。**生の目標値を直接使わない** */
let camDist = CAM.dist;

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

export function load(data: Replay & ReplayExtras, matchEvents: MatchEvent[], homeTeamName: string,
                     callbacks: PitchCallbacks): void {
  replay = data;
  actsOf = data.roster.map(() => []);
  for (const a of data.acts ?? []) {
    /* 🔑 蹴ったボールの向きへ体を向ける（走ってきた向きのまま蹴ると、横へ蹴っても前を向いて見える） */
    const f0 = data.frames[a.frame];
    const f1 = data.frames[Math.min(data.frames.length - 1, a.frame + 2)];
    let dir: number | null = null;
    if (a.act !== "down" && f0 !== undefined && f1 !== undefined) {
      const dx = f1[0]! - f0[0]!;
      const dy = f1[1]! - f0[1]!;
      if (Math.hypot(dx, dy) > 0.5 * data.coord_scale) dir = Math.atan2(dy, dx);
    }
    actsOf[a.who]?.push({ start: a.frame * data.sample_ticks - ACT_TIMING[a.act].lead, act: a.act, dir });
  }
  for (const list of actsOf) list.sort((m, n) => m.start - n.start);
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
  /* 🔴 引きも1コマ目の場面に合わせて**置き直す**。前の試合の値から始めると、
        キックオフの直後に理由のない寄り（または引き）が1秒ほど走る */
  camDist = distFor(look.x);
  ballPrev = null;
  lookZ = 0;
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

/* ------------------------------------------------------------ カメラ */

/**
 * 場面に合った引き（m）。ゴールラインに近いほど寄る。
 *
 * 🔴 ここが返すのは**目標**で、画に出る値ではない。これを直接 `cam.dist` に
 *    入れると、ボールが境目を跨いだ瞬間に画がカクッと伸び縮みして酔う。
 *    実際の寄りは `aim()` が指数でゆっくり追う。
 */
function distFor(ballX: number): number {
  /* 🔑 「どちらかのゴールに近いか」だけを見る。ゴール口の中心までの距離にすると、
        コーナーが中盤と同じ扱いになってしまう（コーナーはゴール前の攻防なので寄りたい） */
  const toLine = Math.min(ballX, C.PITCH_X - ballX);
  const u = smooth01((toLine - ZOOM_NEAR_X) / (ZOOM_FAR_X - ZOOM_NEAR_X));
  return DIST_NEAR + (CAM.dist - DIST_NEAR) * u;
}

/**
 * 画角（焦点距離）。**窓の縦も見る**。
 *
 * 🔴 横幅だけで決めていた（2026-10-03 まで）。横に長く縦の短い窓では
 *    縦の画角が足りず、選手が膝から下しか画に入らない。
 *    縦・横それぞれが要求する焦点距離を出して、**短い方＝広い方**を採る。
 * 🔑 16:9 のときは横で決まるので、オーナーが見て決めた画はそのまま。
 *    min を取るので、**前より寄ることは起きない**（広がる方向にだけ動く）。
 */
function focalFor(cv: HTMLCanvasElement): number {
  const byWidth = CAM.focal * (cv.width / REF.w);
  const byHeight = CAM.focal * (cv.height / REF.h);
  return Math.min(byWidth, byHeight);
}

/**
 * 注視点と引きを場面へ寄せる。1コマに1回だけ呼ぶ。
 *
 * @param men ボールの近くを数えるための全選手の位置（この関数は書き換えない）
 */
function aim(dt: number, ballX: number, ballY: number,
             men: readonly { x: number; y: number }[]): void {
  /* 🔑 ボールだけを見ると、走り込んでいる選手が画面の外に出て
        「誰が空けたのか・誰が詰めたのか」が読めない。ボールの近くにいる
        選手の重心へ少し寄せて、人のかたまりごと画に入れる。
     🔴 **全員の重心は使えない。** 22人の重心はほぼセンターサークルに居座るので、
        どこで何が起きていてもカメラが中央へ引っ張られ、ボールから目が離れる。 */
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const m of men) {
    if (Math.hypot(m.x - ballX, m.y - ballY) > CROWD_R) continue;
    sx += m.x;
    sy += m.y;
    n += 1;
  }
  /* 寄せる先はボールと重心のあいだ。ずれる量は CROWD_R × CROWD_W（≒5m）で頭打ちになる */
  const aimX = n > 0 ? ballX + (sx / n - ballX) * CROWD_W : ballX;
  const aimY = n > 0 ? ballY + (sy / n - ballY) * CROWD_W : ballY;

  /* 🔑 カメラは**遅れて寄る**。すぐ張り付くと、速いパスのたびに
        画面全体が跳ねて何が起きたか読めない。
        横（world x）は画に24m入るので、基準値のまま素直に追う。 */
  look.x += (aimX - look.x) * (1 - Math.exp(-FOLLOW_X * dt));

  /* 縦（world y）は鈍くする。ただし離れすぎたら引き綱で引き戻す（`LEASH_FRAC` の説明）。
     🔴 **綱の長さは「ボール」との離れで測る**（2026-10-03 のレビューで直した）。
        以前は寄せ先（`aimY`）との離れで測っていたが、`aimY` は重心を混ぜた点なので、
        ボールは `aimY` からさらに最大 CROWD_R × CROWD_W ≒ 4.9m 離れうる。
        つまり**守るつもりだったボールが、綱の外にいた**。 */
  const offY = Math.abs(ballY - look.y);
  const followY = FOLLOW_Y + Math.max(0, offY - camDist * LEASH_FRAC) * LEASH_GAIN;
  look.y += (aimY - look.y) * (1 - Math.exp(-followY * dt));

  camDist += (distFor(ballX) - camDist) * (1 - Math.exp(-ZOOM * dt));
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

  /* 🔴 選手の座標を**カメラより先に**出す。注視点がボールの近くにいる選手の
        重心を混ぜるので、全員の位置が分かる前にカメラを組むと1コマ遅れる。
        並べ替えに使う奥行き `d` だけは、カメラが決まってから入れる。 */
  const list: { i: number; x: number; y: number; sp: number; d: number }[] = [];
  for (let i = 0; i < rp.roster.length; i++) {
    const x = lerp(3 + i * 2);
    const y = lerp(4 + i * 2);
    const dx = (fb[3 + i * 2]! - fa[3 + i * 2]!) / k;
    const dy = (fb[4 + i * 2]! - fa[4 + i * 2]!) / k;
    const sp = Math.hypot(dx, dy) / rp.sample_ticks;
    if (sp > 0.25) facings[i] = Math.atan2(dy, dx);
    /* 🔴 **実際の秒数で進める**（2026-10-03 のレビューで判明）。
          ここは「進んだ距離に比例して進む歩調カウンタ」だった（`sp * dt * 0.9`）が、
          `voxel.ts` の姿勢は**秒を前提**に周期を書いている。距離で進めると、
          止まっている選手は `sp≈0` なので**呼吸も止まり**、
          減速しながら滑り込む選手は滑り込みの途中で絵が止まる。
       🔑 足並みは `load()` で入れた一人ずつ違う初期値がそろえない。 */
    phases[i] = (phases[i]! + dt) % 1000;
    list.push({ i, x, y, sp, d: 0 });
  }

  aim(dt, bx, by, list);
  /* 🔑 高さがあれば浮かせる（浮き球・クロス・シュート）。無ければ地面に置く（旧エンジン） */
  const bz = rp.ballZ !== undefined ? Math.max(0, ballLerp(rp.ballZ, a, bIdx, t) / k) : 0;
  lookZ += (bz * LOOK_Z_FRAC - lookZ) * (1 - Math.exp(-LOOK_Z_FOLLOW * dt));

  const cam: Voxel.Cam = {
    yaw: CAM.yaw, pitch: CAM.pitch, dist: camDist,
    focal: focalFor(cv),
    target: { x: look.x, y: look.y, z: lookZ },
    cx: cv.width / 2,
    cy: cv.height * 0.56,
  };

  /* 🔴 空 → 観客席 → ピッチ の順。屋根と照明塔は空へ伸びるので、
        空より後・ピッチより先に描く必要がある */
  /* 🔑 盛り上がりは**時間とともに冷める**。得点した瞬間に 1 を入れて、
        あとはここで落とす。入れっぱなしにすると、客席が90分跳ね続ける。 */
  excite = Math.max(0, excite - dt / EXCITE_FADE);
  Stadium.draw(c, cam, clock, excite);
  Field.draw(c, cam);

  /* 🔴 奥から手前へ。並べ替えの奥行きは**カメラと同じ式**（`basisOf`）から取る。
        目の位置を手で組み直していた（2026-10-03 まで）が、見下ろし角ぶんの
        cos が抜けていた。引きが場面で変わるようになったので、自前の式だと
        寄った瞬間だけ並びが狂って奥の選手が手前に出る。
     🔑 選手は全員 z=0 なので、奥行きに z の項は要らない（全員同じ値になり順番に効かない）。 */
  const basis = Voxel.basisOf(cam);
  for (const p of list) {
    p.d = (p.x - basis.eye.x) * basis.fwd.x + (p.y - basis.eye.y) * basis.fwd.y;
  }
  list.sort((m, n) => n.d - m.d);

  for (const { i, x, y, sp } of list) {
    const who = rp.roster[i]!;
    const kit = KIT[who.pos === "GK" ? "gk" : (who.team === 0 ? "home" : "away")]!;
    /* 🔴 姿勢の選び方を**ここに書かない**（2026-10-03 のレビューで直した）。
          以前はここに三項演算子で境目を持っていたので、同じ数字（5.2 と 0.6）が
          `voxel.ts` / `match3d.ts` / `pitch3d.ts` の3か所に散り、
          確認台で境目を詰めても試合画面が1ドットも変わらなかった。
          境目は `voxel.ts` の `pickPose` の1か所だけに置く。 */
    /* 🔑 動作の途中なら、その動作の姿勢と「動作が始まってからの秒数」で描く */
    const now = frameIndex * rp.sample_ticks;
    const act = actAt(i, now);
    const pose: Pose = Voxel.pickPose({ speed: sp, hasBall: i === owner,
                                        act: act === null || act.act === "down" ? null : act.act,
                                        down: act?.act === "down" });
    if (act !== null && act.dir !== null) facings[i] = act.dir;
    const tt = act === null ? phases[i]! : (now - act.start) * ACT_TIMING[act.act].rate;
    const at = { x, y, z: 0 };
    Voxel.drawShadow(c, cam, at, pose === "down" || pose === "tackle" ? { pose, facing: facings[i]! } : undefined);
    Voxel.drawPlayer(c, cam, { at, facing: facings[i]!, pose, t: tt, kit });
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
  Field.drawBall(c, cam, { x: bx, y: by, z: Field.BALL_R + bz }, ballSpin, ballDir);

  drawMinimap(rp, fa, fb, t, k);
}

/** コマ a と b のあいだのボールの高さ（coord_scale のまま） */
function ballLerp(z: number[], a: number, b: number, t: number): number {
  const za = z[a] ?? 0;
  const zb = z[b] ?? za;
  return za + (zb - za) * t;
}

/** 選手 i が時刻 now（秒）にしている動作。無ければ null。重なったら後に始まった方 */
function actAt(i: number, now: number): { start: number; act: ReplayAct["act"]; dir: number | null } | null {
  const list = actsOf[i];
  if (list === undefined) return null;
  let found: { start: number; act: ReplayAct["act"]; dir: number | null } | null = null;
  for (const a of list) {
    if (a.start > now) break;
    if (now < a.start + ACT_TIMING[a.act].len) found = a;
  }
  return found;
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

/** 試合の sec 秒目へ飛ぶ（確認台で場面を見に行く用）。🔑 カメラは次のコマから指数で追いつく */
export function seek(sec: number): void {
  const rp = need(replay, "再生データ");
  frameIndex = Math.max(0, Math.min(rp.frames.length - 1, sec / rp.sample_ticks));
  ballPrev = null;
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
