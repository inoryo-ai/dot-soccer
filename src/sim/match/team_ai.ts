/**
 * チームAI（D-42 の3層のいちばん上・作る順 3）。
 *
 * 1秒ごと（＋持ち主が変わった・外へ出た直後）に、チーム全体の形と役割を決める。
 *   局面   … 持っている（ATTACK）／持たれている（DEFEND）／誰も持っていない（LOOSE）
 *   陣形   … ブロックの深さ・縦の長さ・横幅。ボールの位置に合わせて前後左右へ動く
 *   役割   … 守備: 寄せる1人（PRESS）とその後ろを埋める1人（COVER）
 *            攻撃: パスの出し先の候補（OUTLET）を数人に絞る
 *
 * 🔑 **候補を絞るのはチームAIの仕事。** 選手AIは渡された候補の中だけを先読みする。
 *    10人全員を毎回先読みしていた頃は、計算の 73% がパス選びだった（2026-10-05 計測）。
 * 🔑 陣形の長さ・幅は「監督がこう指示する」値。現実の実測（`docs/realism-reference.md` §2）を
 *    そのまま指示値に使い、実際の陣形がそこからどれだけ揺れるかを物差しで見る。
 *
 * 🔴 乱数は一切使わない（D-42）。
 */

import { hypot } from "../pymath.ts";
import type { Ball } from "./ball.ts";
import type { Agent } from "./player_ai.ts";
import { attackDir } from "./player_ai.ts";
import { PITCH_LENGTH_M, PITCH_WIDTH_M, REACH_M, timeToReach } from "./reach.ts";

export type Phase = "ATTACK" | "DEFEND" | "LOOSE";

export interface Order {
  x: number;
  y: number;
  effort: number;
  role: "BLOCK" | "PRESS" | "COVER" | "OUTLET" | "GK";
}

export interface TeamPlan {
  phase: Phase;
  /** 選手の番号 → 指示 */
  orders: Map<number, Order>;
  /** パスの出し先の候補（攻撃時だけ。それ以外は空） */
  outlets: number[];
}

/** チームAIが考え直す間隔（コマ＝0.1秒）。D-42: 1秒ごと＋節目 */
export const TEAM_DECIDE_EVERY_TICKS = 10;

/**
 * 陣形の縦の長さ × 横幅（GK を除く10人・m）。
 * 守備: 32.5 × 37.3（Forcher ら 2024、ブンデスリーガ 153試合 TRACAB）
 * 攻撃: 36 × 41（Rico-González ら 2022 の総説の孫引き＝監視のみの値だが、指示値としては使う）
 */
export const SHAPE: Readonly<Record<"ATTACK" | "DEFEND", { length: number; width: number }>> = {
  ATTACK: { length: 36.0, width: 41.0 },
  DEFEND: { length: 32.5, width: 37.3 },
};

/**
 * ブロックの真ん中を、自陣ゴールから「ボールまでの距離 × BLOCK_FOLLOW ＋ ずらし」に置く。
 * 🔑 設計値（出典なし）。確かめ方: 最終ラインと自陣ゴールの距離が、
 *    守備時はボールの位置しだいで約 6〜45m、攻撃時は 38±8m（Rico-González ら 2022・監視のみ）に入るか。
 *    守備: ボールが自陣ペナルティエリア（15m）→ 最終ライン 約6m、相手陣深く（85m）→ 約45m。
 */
export const BLOCK_FOLLOW = 0.6;
export const BLOCK_OFFSET_M: Readonly<Record<"ATTACK" | "DEFEND", number>> = { ATTACK: 22.0, DEFEND: 10.0 };
/** 横はボールの側へこれだけ寄る（ボールのずれ × この値）。設計値（出典なし） */
export const BLOCK_SLIDE = 0.5;
/** GK が構える自陣ゴールからの距離（旧エンジンの GK_DEPTH_M と同じ） */
export const GK_DEPTH_M = 5.0;
/** パスの出し先の候補の数。設計値（出典なし） */
export const OUTLET_COUNT = 3;
/** COVER がボールのどれだけ後ろ（自陣ゴール側）に立つか（m）。設計値（出典なし） */
export const COVER_BEHIND_M = 6.0;
/** 隊形へ戻るときの本気度。設計値（出典なし） */
export const BLOCK_EFFORT = 0.7;

/**
 * チームの計画を立てる。
 * @param holder 持っている人（いなければ null）
 */
export function planTeam(team: 0 | 1, agents: readonly Agent[], ball: Ball,
                         holder: Agent | null): TeamPlan {
  const phase: Phase = holder === null ? "LOOSE" : holder.team === team ? "ATTACK" : "DEFEND";
  const orders = new Map<number, Order>();
  const mine = agents.filter((a) => a.team === team);
  const dir = attackDir(team);
  const ownGoalX = dir > 0 ? 0.0 : PITCH_LENGTH_M;

  // ---- 陣形（LOOSE のあいだは直前の形を保つ代わりに、守備の形で待つ）
  const shape = SHAPE[phase === "ATTACK" ? "ATTACK" : "DEFEND"];
  const offset = BLOCK_OFFSET_M[phase === "ATTACK" ? "ATTACK" : "DEFEND"];
  const ballDepth = Math.abs(ball.x - ownGoalX);            // 自陣ゴールからボールまで
  const center = clamp(BLOCK_FOLLOW * ballDepth + offset,
                       shape.length / 2 + 6.0, PITCH_LENGTH_M - shape.length / 2 - 6.0);
  const centerY = PITCH_WIDTH_M / 2 + (ball.y - PITCH_WIDTH_M / 2) * BLOCK_SLIDE;

  // フォーメーションの持ち場を「深さ 0〜1・横 0〜1」に直して、長さ・幅をかける
  const field = mine.filter((a) => a.role !== "GK");
  const depths = field.map((a) => Math.abs(a.homeX - ownGoalX));
  const lats = field.map((a) => a.homeY);
  const [dMin, dMax] = [Math.min(...depths), Math.max(...depths)];
  const [lMin, lMax] = [Math.min(...lats), Math.max(...lats)];
  field.forEach((a, i) => {
    const u = dMax > dMin ? (depths[i]! - dMin) / (dMax - dMin) : 0.5;
    const w = lMax > lMin ? (lats[i]! - lMin) / (lMax - lMin) : 0.5;
    const depth = center - shape.length / 2 + u * shape.length;
    orders.set(a.id, {
      x: clamp(ownGoalX + dir * depth, 1.0, PITCH_LENGTH_M - 1.0),
      y: clamp(centerY - shape.width / 2 + w * shape.width, 1.0, PITCH_WIDTH_M - 1.0),
      effort: BLOCK_EFFORT,
      role: "BLOCK",
    });
  });
  for (const gk of mine.filter((a) => a.role === "GK")) {
    orders.set(gk.id, {
      x: ownGoalX + dir * GK_DEPTH_M,
      y: PITCH_WIDTH_M / 2 + (ball.y - PITCH_WIDTH_M / 2) * 0.25,
      effort: BLOCK_EFFORT,
      role: "GK",
    });
  }

  // ---- 役割
  const outlets: number[] = [];
  if (phase === "DEFEND") {
    // いちばん早く寄せられる1人が寄せ、次の1人がその後ろ（ボールと自陣ゴールの間）を埋める
    const ranked = field
      .map((a) => ({ a, t: timeToReach(a.body, ball.x, ball.y, REACH_M) }))
      .sort((p, q) => p.t - q.t || p.a.id - q.a.id);
    const press = ranked[0];
    const cover = ranked[1];
    if (press !== undefined) {
      orders.set(press.a.id, { x: ball.x, y: ball.y, effort: 1.0, role: "PRESS" });
    }
    if (cover !== undefined) {
      const gx = ownGoalX - ball.x;
      const gy = PITCH_WIDTH_M / 2 - ball.y;
      const g = hypot(gx, gy) || 1.0;
      orders.set(cover.a.id, {
        x: ball.x + gx / g * COVER_BEHIND_M, y: ball.y + gy / g * COVER_BEHIND_M,
        effort: 0.9, role: "COVER",
      });
    }
  } else if (phase === "ATTACK" && holder !== null) {
    // 出し先の候補: 相手からの空き ＋ 前への進み、が大きい順に OUTLET_COUNT 人
    const opponents = agents.filter((a) => a.team !== team);
    const scored = field
      .filter((a) => a.id !== holder.id)
      .map((a) => {
        const d = hypot(a.body.x - ball.x, a.body.y - ball.y);
        if (d < 5.0 || d > 45.0) return null;
        let open = Infinity;
        for (const o of opponents) open = Math.min(open, hypot(o.body.x - a.body.x, o.body.y - a.body.y));
        const progress = (a.body.x - ball.x) * dir;
        return { a, score: Math.min(open, 15.0) + 0.3 * progress };
      })
      .filter((s): s is { a: Agent; score: number } => s !== null)
      .sort((p, q) => q.score - p.score || p.a.id - q.a.id);
    for (const s of scored.slice(0, OUTLET_COUNT)) {
      outlets.push(s.a.id);
      orders.get(s.a.id)!.role = "OUTLET";
    }
  }
  return { phase, orders, outlets };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
