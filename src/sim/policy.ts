/**
 * 学習する判断（D-48）。候補の行動ひとつずつに点を付け、一番高いものを選ぶ小さな網（ニューラルネット）。
 *
 * 🔑 **能力を必ず入力に入れる**（Phase 0 §9.1）。入れないと全員が同じ「最強の1手」に落ち、特訓の意味が消える。
 * 🔑 **決定論**: 掛け算・足し算・比較（ReLU）と `detmath` だけ。同じ重み・同じ場面なら必ず同じ選択（D-08）。
 *    同点は先に並んだ候補（`撃つ` → 運ぶ向きの順）。
 * 🔑 網の形は「場面＋候補の特徴 → 隠れ層（ReLU）→ 点」。候補ごとに同じ網を通すので、候補の数が変わっても重みは同じ。
 */

import type { AttackAct, AttackPolicy, DefendMove, DefendPolicy, Scene } from "./arena.ts";
import { inside, placeValue } from "./arena.ts";
import type { Actor } from "./actor.ts";
import * as C from "./constants.ts";
import { atan2, cos, sin } from "./detmath.ts";
import * as Phys from "./physics.ts";
import { hypot } from "./pymath.ts";

/** 網の重み。`w1[h*inputs + i]`・`b1[h]`・`w2[h]`・`b2` */
export interface NetWeights {
  inputs: number;
  hidden: number;
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number;
}

/** 重みの数（平たい配列の長さ） */
export function netSize(inputs: number, hidden: number): number {
  return hidden * inputs + hidden + hidden + 1;
}

/** 平たい配列 → 重み */
export function unflatten(v: readonly number[], inputs: number, hidden: number): NetWeights {
  if (v.length !== netSize(inputs, hidden)) {
    throw new Error(`重みの数が合わない: ${v.length}（${inputs}入力×${hidden}隠れ なら ${netSize(inputs, hidden)}）`);
  }
  let o = 0;
  const take = (n: number): number[] => {
    const out = v.slice(o, o + n);
    o += n;
    return out;
  };
  const w1 = take(hidden * inputs);
  const b1 = take(hidden);
  const w2 = take(hidden);
  return { inputs, hidden, w1, b1, w2, b2: v[o]! };
}

/** 点を出す。特徴の数が網と合わなければ止める（黙って違う特徴で動かない） */
export function score(net: NetWeights, x: readonly number[]): number {
  if (x.length !== net.inputs) throw new Error(`特徴の数が網と合わない: ${x.length} / ${net.inputs}`);
  let out = net.b2;
  for (let h = 0; h < net.hidden; h++) {
    let z = net.b1[h]!;
    const row = h * net.inputs;
    for (let i = 0; i < net.inputs; i++) z += net.w1[row + i]! * x[i]!;
    if (z > 0) out += net.w2[h]! * z;
  }
  return out;
}

/** 能力（0〜100）を -1〜1 に */
const st = (v: number): number => (v - 50.0) / 50.0;

/** 選手の能力の特徴（疲れ込みの実効値）。**判断の材料に能力を入れる**（Phase 0 §9.1） */
function abilities(a: Actor): number[] {
  const p = a.player;
  return [st(a.eff(p.speed)), st(a.eff(p.technique)), st(a.eff(p.physical)), st(a.eff(p.kick))];
}

// ------------------------------------------------------------------ 攻め

/** 攻めが比べる運ぶ向き（ゴールの真ん中への向きからのずれ・ラジアン）。下げる向きも選べる */
export const ATTACK_ANGLES: readonly number[] = [0.0, -0.45, 0.45, -0.9, 0.9, -1.4, 1.4, -2.3, 2.3];

/** 攻めの特徴の数 */
export const ATTACK_INPUTS = 25;   // 場面16＋候補9（数え間違いは `score` が止める・`tests/policy.test.ts`）

/**
 * 攻めの特徴（場面＋候補）。
 * 場面: 自分の能力4・守りの能力4・ゴールまでの距離と向き・守りとGKの相対位置・ここで撃った入る確率
 * 候補: 撃つか・運ぶ向き・運んだ先の価値・前の相手を抜ける確率・運んだ先で撃った入る確率・区切りの端までの近さ
 */
function attackFeatures(s: Scene, shoot: boolean, off: number): number[] {
  const h = s.attacker;
  const d = s.defender;
  const k = s.keeper;
  const opps = [d, k];
  const gx = C.PITCH_X;
  const gy = C.PITCH_Y / 2;
  const dist = hypot(gx - h.x, gy - h.y);
  const toward = atan2(gy - h.y, gx - h.x);
  const xgHere = dist <= C.SHOOT_RANGE_M ? Phys.expectedGoalAt(h, opps, gx, h.x, h.y, dist) : 0.0;
  const scene = [
    ...abilities(h), ...abilities(d),
    dist / C.ARENA_DEPTH_M, (h.y - gy) / (C.ARENA_WIDTH_M / 2),
    (d.x - h.x) / 10.0, (d.y - h.y) / 10.0, hypot(d.x - h.x, d.y - h.y) / 10.0,
    (k.x - h.x) / 10.0, (k.y - h.y) / 10.0,
    xgHere * 5.0,
  ];
  if (shoot) return [...scene, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  const ang = toward + off;
  const dirX = cos(ang);
  const dirY = sin(ang);
  const [nx, ny] = Phys.dribbleTarget(h, dirX, dirY);
  const ahead = Phys.opponentAhead(opps, h.x, h.y, h.x + dirX * 100.0, h.y + dirY * 100.0);
  const keep = ahead === null ? 1.0 : Phys.dribbleChance(h, ahead);
  const nd = hypot(gx - nx, gy - ny);
  const xgThere = nd <= C.SHOOT_RANGE_M ? Phys.expectedGoalAt(h, opps, gx, nx, ny, nd) : 0.0;
  const edge = Math.min(ny - s.area.y0, s.area.y1 - ny, nx - s.area.x0) / 5.0;
  return [...scene, 0.0, cos(off), sin(off), placeValue(s.table, nx, ny) * 5.0, keep,
          ahead === null ? 0.0 : 1.0, xgThere * 5.0, Math.max(-1.0, Math.min(1.0, edge)), nd / C.ARENA_DEPTH_M];
}

/** 学習した攻め。候補（撃つ・各向きへ運ぶ）に点を付けて一番高いものを選ぶ */
export function netAttack(net: NetWeights): AttackPolicy {
  if (net.inputs !== ATTACK_INPUTS) throw new Error(`攻めの網の入力は ${ATTACK_INPUTS}（${net.inputs} が来た）`);
  return {
    decide(s: Scene): AttackAct {
      const h = s.attacker;
      const dist = hypot(C.PITCH_X - h.x, C.PITCH_Y / 2 - h.y);
      let best: AttackAct | null = null;
      let bestV = -Infinity;
      // 🔑 撃てるのは射程の中だけ（物理の約束。11対11 と同じ）
      if (dist <= C.SHOOT_RANGE_M) {
        bestV = score(net, attackFeatures(s, true, 0.0));
        best = { kind: "SHOOT" };
      }
      const toward = atan2(C.PITCH_Y / 2 - h.y, C.PITCH_X - h.x);
      for (const off of ATTACK_ANGLES) {
        const ang = toward + off;
        const dirX = cos(ang);
        const dirY = sin(ang);
        const [nx, ny] = Phys.dribbleTarget(h, dirX, dirY);
        if (!inside(s.area, nx, ny)) continue;
        const v = score(net, attackFeatures(s, false, off));
        if (v > bestV) {
          bestV = v;
          best = { kind: "DRIBBLE", dirX, dirY };
        }
      }
      return best ?? { kind: "SHOOT" };
    },
  };
}

// ------------------------------------------------------------------ 守り

/** 守りが比べる立ち位置: ボールそのもの（寄せ切る）／ボールとゴールを結ぶ線の上、ボールから何m手前か */
export const DEFEND_DEPTHS: readonly number[] = [0.0, 2.5, 5.0, 8.0];
/** 守りが比べる本気度（全力で急ぐ／ジョグで間合いを取る） */
export const DEFEND_EFFORTS: readonly [number, boolean][] = [[1.0, true], [0.6, false]];

/** 守りの特徴の数 */
export const DEFEND_INPUTS = 19;

function defendFeatures(s: Scene, depth: number, effort: number): number[] {
  const h = s.attacker;
  const d = s.defender;
  const [tx, ty] = defendPoint(s, depth);
  return [
    ...abilities(d), ...abilities(h),
    hypot(C.PITCH_X - h.x, C.PITCH_Y / 2 - h.y) / C.ARENA_DEPTH_M,
    (h.x - d.x) / 10.0, (h.y - d.y) / 10.0, hypot(h.x - d.x, h.y - d.y) / 10.0,
    // 自分がボールよりゴール側にいるか（+ ならゴール側）
    (d.x - h.x) / 10.0,
    depth / 8.0, effort,
    (tx - d.x) / 10.0, (ty - d.y) / 10.0, hypot(tx - d.x, ty - d.y) / 10.0,
    hypot(C.PITCH_X - tx, C.PITCH_Y / 2 - ty) / C.ARENA_DEPTH_M,
  ];
}

/** ボールとゴールの真ん中を結ぶ線の上、ボールから `depth` m ゴール側の点 */
function defendPoint(s: Scene, depth: number): [number, number] {
  const h = s.attacker;
  const vx = C.PITCH_X - h.x;
  const vy = C.PITCH_Y / 2 - h.y;
  const len = hypot(vx, vy);
  if (len <= 0 || depth <= 0) return [h.x, h.y];
  const t = Math.min(depth, len) / len;
  return [h.x + vx * t, h.y + vy * t];
}

/** 学習した守り。立ち位置×本気度の候補に点を付けて一番高いものを選ぶ */
export function netDefend(net: NetWeights): DefendPolicy {
  if (net.inputs !== DEFEND_INPUTS) throw new Error(`守りの網の入力は ${DEFEND_INPUTS}（${net.inputs} が来た）`);
  return {
    move(s: Scene): DefendMove {
      let best: DefendMove | null = null;
      let bestV = -Infinity;
      for (const depth of DEFEND_DEPTHS) {
        for (const [effort, urgent] of DEFEND_EFFORTS) {
          const v = score(net, defendFeatures(s, depth, effort));
          if (v > bestV) {
            bestV = v;
            const [tx, ty] = defendPoint(s, depth);
            best = { tx, ty, effort, urgent };
          }
        }
      }
      return best!;
    },
  };
}
