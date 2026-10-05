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
import { PENALTY_AREA_DEPTH_M, inOwnPenaltyArea, keepAway, offsideLineX } from "./laws.ts";
import type { Pace } from "./pace.ts";
import { openAt, receiveFactor, xtAt } from "./value.ts";
import type { Restart } from "./laws.ts";
import { STANDARD } from "./tactics.ts";
import type { Tactics } from "./tactics.ts";

export type Phase = "ATTACK" | "DEFEND" | "LOOSE";

export interface Order {
  x: number;
  y: number;
  /** どのペースで向かうか（pace.ts）。JOG は「持ち場の調整」で、遠ければ選手AIがランニングに上げる */
  pace: Pace;
  role: "BLOCK" | "PRESS" | "CONTAIN" | "COVER" | "SHIELD" | "OUTLET" | "GK" | "TAKER" | "RUNNER" | "BOX";
}

/** 再開を待っているところ（match.ts が持つ）。taker は蹴る人の番号 */
export interface RestartState extends Restart {
  taker: number;
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

// 🔑 陣形の縦の長さ・横幅、ラインの位置、寄せ・塞ぐ・走り込む人数などは、チームごとの戦術（tactics.ts）。
//    標準の型の陣形は現実の実測から: 守備 32.5 × 37.3（Forcher ら 2024、ブンデスリーガ 153試合 TRACAB）、
//    攻撃 36 × 41（Rico-González ら 2022 の総説の孫引き＝監視のみの値だが、指示値としては使う）

/**
 * 🔑 ゴール前で陣形を詰める（どの戦術でも使う守り方の部品）。守るときの縦の長さと横幅を、ボールが自陣ゴールに
 *    近づくほど縮める。ボールが COMPACT_FROM_M 以上離れていれば tactics.defendShape のまま、COMPACT_TO_M まで来たら
 *    tactics.compactShape、その間は直線でつなぐ。
 *    詰めた形は、出典の実測（守備時 縦 32.5±8.7m × 横 37.3±4.8m・Forcher ら 2024）のばらつきの下側
 *    （平均 − 標準偏差1つ）。🔴 いつも平均の 32.5m のままだと、ゴール前で DF と MF の2列の間が空き、
 *    そこへ運び込まれて 1試合 20〜30点入った（2026-10-05）
 */
export const COMPACT_FROM_M = 50.0;
export const COMPACT_TO_M = 15.0;

export function compactDefence(ballDepth: number, tactics: Tactics = STANDARD): { length: number; width: number } {
  const t = clamp((ballDepth - COMPACT_TO_M) / (COMPACT_FROM_M - COMPACT_TO_M), 0.0, 1.0);
  const far = tactics.defendShape;
  const near = tactics.compactShape;
  return {
    length: near.length + (far.length - near.length) * t,
    width: near.width + (far.width - near.width) * t,
  };
}

/**
 * ブロックの真ん中を、自陣ゴールから「ボールまでの距離 × BLOCK_FOLLOW ＋ ずらし」に置く。
 * 🔑 設計値（出典なし）。確かめ方: 最終ラインと自陣ゴールの距離が、
 *    守備時はボールの位置しだいで約 6〜45m、攻撃時は 38±8m（Rico-González ら 2022・監視のみ）に入るか。
 *    守備: ボールが自陣ペナルティエリア（15m）→ 最終ライン 約6m、相手陣深く（85m）→ 約45m。
 */
export const BLOCK_FOLLOW = 0.6;
/** 横はボールの側へこれだけ寄る（ボールのずれ × この値）。設計値（出典なし） */
export const BLOCK_SLIDE = 0.5;
/** GK が構える自陣ゴールからの距離の上限（旧エンジンの GK_DEPTH_M と同じ） */
export const GK_DEPTH_M = 5.0;
/**
 * GK はゴールの中心とボールを結ぶ線の上に、ボールまでの距離のこの割合だけ前に出て構える（1m〜GK_DEPTH_M）。
 * 🔑 設計値（出典なし）。いつも 5m 前に立つと、浮き球の無いいまの作りでは 11m のシュートでもゴールの幅を
 *    すべて覆ってしまった（2026-10-05）。確かめ方: 枠内シュートのセーブ率・決定率 約11%
 */
export const GK_DEPTH_RATIO = 0.12;
// 🔑 プレスのスイッチ（tactics.pressStartM）: 相手のボールが自陣ゴールからこの距離より近ければ寄せる（PRESS）、
//    遠ければ寄せずにボールと自陣ゴールの間で構える（CONTAIN）。オーナー指摘「プレスが早すぎる」（2026-10-05）
/** 寄せ役は正面の選手を優先するが、いちばん早い選手よりこれ以上遅れるなら、いちばん早い選手にする（秒）。設計値 */
export const CHALLENGE_SLACK_S = 1.0;
/**
 * DF ラインの段差（守備時・m）。🔑 設計値（出典なし）。ボール側のサイドバックは前へ出て、
 * 逆サイドのサイドバックは中へ絞って下がり、逆サイド側の CB は下がってカバーする。
 * オーナー指摘「DF ラインが綺麗すぎる」（2026-10-05・DF 4人の前後のばらつき 約1m）
 */
export const FB_STEP_UP_M = 4.0;
export const FB_TUCK_IN_M = 6.0;
export const FB_DROP_M = 2.0;
export const CB_COVER_DROP_M = 2.0;
/**
 * シュートコースを塞ぐ（SHIELD）: 相手のボールが自陣ゴールから tactics.shieldZoneM 以内なら、寄せ役以外で
 * ボールより自陣ゴール側の近い tactics.shieldCount 人が、ボールとゴールの中心を結ぶ線の上（ボールから SHIELD_DISTS_M）に
 * 左右へ SHIELD_SPREAD_M ずらして立つ。🔑 設計値（出典なし）。
 * 塞ぐ人がいないと、ゴール前 17m まで運んで空いたコースへ撃ち放題になった（1チーム 約48本・2026-10-05）
 */
export const SHIELD_DISTS_M: readonly number[] = [4.0, 7.0];
export const SHIELD_SPREAD_M = 1.5;
/** 構える（CONTAIN）とき、ボールから自陣ゴールの向きにどれだけ離れて立つか（m）。🔑 設計値（出典なし） */
export const CONTAIN_DIST_M = 8.0;
/** PK のとき、ペナルティマークから離れる距離（第14条: 9.15m） */
export const KEEP_AWAY_PK_M = 9.15;
/** COVER がボールのどれだけ後ろ（自陣ゴール側）に立つか（m）。設計値（出典なし） */
export const COVER_BEHIND_M = 6.0;
/**
 * オフサイドラインからゴールラインまでがこれより狭ければ、裏へは走らない（m）。
 * 🔑 設計値（出典なし）。走り込む先が無い（相手が自陣ゴール前まで下がっている）とき
 */
export const RUN_SPACE_MIN_M = 12.0;
/**
 * クロスの場面: ボールが相手ゴールラインからこの距離以内で、かつ中央からこれだけ外（サイド）にあるとき、
 * ゴール前へ入る役（BOX）を tactics.boxCount 人まで出す。🔑 設計値（出典なし）
 */
export const CROSS_ZONE_DEPTH_M = 30.0;
export const CROSS_ZONE_WIDE_M = 12.0;

/**
 * チームの計画を立てる。
 * @param holder 持っている人（いなければ null）
 */
export function planTeam(team: 0 | 1, agents: readonly Agent[], ball: Ball,
                         holder: Agent | null, restart: RestartState | null = null,
                         lastTeam: 0 | 1 | null = null, tactics: Tactics = STANDARD,
                         sinceLossS = Infinity): TeamPlan {
  // 🔑 再開を待っている間は、再開するチームが「持っている」側、相手が「持たれている」側。
  //    蹴る人を持っている人とみなして、出し先の候補もその人から選ぶ
  if (restart !== null) holder = agents[restart.taker]!;
  const phase: Phase = holder === null ? "LOOSE" : holder.team === team ? "ATTACK" : "DEFEND";
  const orders = new Map<number, Order>();
  const mine = agents.filter((a) => a.team === team);
  const dir = attackDir(team);
  const ownGoalX = dir > 0 ? 0.0 : PITCH_LENGTH_M;

  // ---- 陣形（LOOSE のあいだは直前の形を保つ代わりに、守備の形で待つ）
  // 🔑 陣形の形は「攻めているか」で決める。ボールが誰のものでもない間（パスが転がっている間も）は、
  //    **最後に触ったチームが攻めている**とみなす。
  //    🔴 以前は転がっている間は両チームとも守備の形で、味方がパスを出すたびにチーム全体が 10m ほど
  //       下がり、受けるとまた出る往復になった。FW がボールを受けた場所の 8割以上が中盤になり、
  //       FW どうしの短い横パスが 50分で 449本・FW が1人 約470回ボールを持った（2026-10-05）
  const attacking = phase === "ATTACK" || (phase === "LOOSE" && lastTeam === team);
  const offset = attacking ? tactics.attackOffsetM : tactics.defendOffsetM;
  const ballDepth = Math.abs(ball.x - ownGoalX);            // 自陣ゴールからボールまで
  const shape = attacking ? tactics.attackShape : compactDefence(ballDepth, tactics);
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
      pace: "JOG",
      role: "BLOCK",
    });
  });
  // 🔑 守備時の DF ラインの段差: 持ち場の横の並びで両端をサイドバック、内側を CB とみなす
  if (!attacking) {
    const dfs = field.filter((a) => a.role === "DF").sort((p, q) => p.homeY - q.homeY || p.id - q.id);
    if (dfs.length >= 3) {
      const ballSideLow = ball.y < PITCH_WIDTH_M / 2;            // ボールが y の小さい側にある
      const near = ballSideLow ? dfs[0]! : dfs[dfs.length - 1]!;  // ボール側のサイドバック
      const far = ballSideLow ? dfs[dfs.length - 1]! : dfs[0]!;   // 逆サイドのサイドバック
      const cbs = dfs.slice(1, -1);
      const farCb = ballSideLow ? cbs[cbs.length - 1] : cbs[0];   // 逆サイド側の CB
      const o1 = orders.get(near.id)!;
      o1.x = clamp(o1.x + dir * FB_STEP_UP_M, 1.0, PITCH_LENGTH_M - 1.0);
      const o2 = orders.get(far.id)!;
      o2.y = clamp(o2.y + (PITCH_WIDTH_M / 2 - o2.y > 0 ? 1 : -1) * FB_TUCK_IN_M, 1.0, PITCH_WIDTH_M - 1.0);
      o2.x = clamp(o2.x - dir * FB_DROP_M, 1.0, PITCH_LENGTH_M - 1.0);
      if (farCb !== undefined) {
        const o3 = orders.get(farCb.id)!;
        o3.x = clamp(o3.x - dir * CB_COVER_DROP_M, 1.0, PITCH_LENGTH_M - 1.0);
      }
    }
  }
  for (const gk of mine.filter((a) => a.role === "GK")) {
    // ゴールの中心からボールへ向かう線の上
    const vx = ball.x - ownGoalX;
    const vy = ball.y - PITCH_WIDTH_M / 2;
    const dist = hypot(vx, vy) || 1.0;
    const depth = clamp(GK_DEPTH_RATIO * dist, 1.0, GK_DEPTH_M);
    orders.set(gk.id, {
      x: ownGoalX + vx / dist * depth,
      y: PITCH_WIDTH_M / 2 + vy / dist * depth,
      pace: "JOG",
      role: "GK",
    });
  }

  // ---- 再開を待っている間の並び（第8・13・15・17条）
  if (restart !== null) {
    if (restart.kind === "KICKOFF") {
      // キックオフ: 全員が自陣に入る。持ち場の深さを半分にして自陣へ畳む
      for (const a of mine) {
        const o = orders.get(a.id)!;
        if (a.role === "GK") continue;
        const depth = Math.min(Math.abs(a.homeX - ownGoalX) / 2.0, PITCH_LENGTH_M / 2 - 1.0);
        o.x = ownGoalX + dir * depth;
        o.y = a.homeY;
      }
    }
    if (restart.kind === "PENALTY") {
      // PK（第14条）: 蹴る人と守る GK のほかは全員ペナルティエリアの外・ペナルティマークから 9.15m 以上。
      //    守る GK はゴールライン上
      const defending = restart.team !== team;
      for (const a of mine) {
        const o = orders.get(a.id)!;
        if (a.id === restart.taker) continue;
        if (a.role === "GK") {
          if (defending) {
            o.x = ownGoalX + dir * 0.3;
            o.y = PITCH_WIDTH_M / 2;
          }
          continue;
        }
        if (inOwnPenaltyArea(defending ? team : ((1 - team) as 0 | 1), o.x, o.y) || hypot(o.x - restart.x, o.y - restart.y) < KEEP_AWAY_PK_M) {
          // エリアの外（ゴールから遠い側）へ
          const edgeX = defending ? ownGoalX + dir * (PENALTY_AREA_DEPTH_M + 2.0)
                                  : (dir > 0 ? PITCH_LENGTH_M : 0.0) - dir * (PENALTY_AREA_DEPTH_M + 2.0);
          o.x = edgeX;
        }
      }
    }
    if (restart.team === team) {
      const t = orders.get(restart.taker)!;
      t.x = restart.x;
      t.y = restart.y;
      t.pace = "JOG";
      t.role = "TAKER";
    } else if (restart.kind !== "PENALTY") {
      // 相手は決められた距離より外へ（ボールから外向きに押し出す）。キックオフはセンターサークルの外
      const r = keepAway(restart.kind) + 0.5;
      for (const a of mine) {
        const o = orders.get(a.id)!;
        const dx = o.x - restart.x;
        const dy = o.y - restart.y;
        const d = hypot(dx, dy);
        if (d >= r) continue;
        const ux = d > 0.0 ? dx / d : -dir;
        const uy = d > 0.0 ? dy / d : 0.0;
        o.x = clamp(restart.x + ux * r, 1.0, PITCH_LENGTH_M - 1.0);
        o.y = clamp(restart.y + uy * r, 1.0, PITCH_WIDTH_M - 1.0);
      }
    }
  }

  // ---- 役割
  const outlets: number[] = [];
  if (phase === "DEFEND" && restart === null) {
    // 寄せる1人と、その後ろ（ボールと自陣ゴールの間）を埋める1人。
    // 🔑 寄せるのは**ボールより自陣ゴール側にいる（正面から向き合える）選手**を優先する。後ろから追う選手は、
    //    運んでくる相手を止められない（ゴール前 14m まで誰にも止められずに運ばれ、1試合 25〜39点・2026-10-05）。
    //    ただし正面の選手が、いちばん早い選手より CHALLENGE_SLACK_S 以上遅れるなら、いちばん早い選手
    const ballDepthNow = Math.abs(ball.x - ownGoalX);
    const ranked = field
      .map((a) => ({ a, t: timeToReach(a.body, ball.x, ball.y, REACH_M),
                     front: Math.abs(a.body.x - ownGoalX) <= ballDepthNow + 1.0 }))
      .sort((p, q) => p.t - q.t || p.a.id - q.a.id);
    const fastest = ranked[0];
    const front = ranked.find((r) => r.front);
    const press = front !== undefined && fastest !== undefined && front.t <= fastest.t + CHALLENGE_SLACK_S
      ? front : fastest;
    const cover = ranked.find((r) => r !== press && r.front) ?? ranked.find((r) => r !== press);
    const gx = ownGoalX - ball.x;
    const gy = PITCH_WIDTH_M / 2 - ball.y;
    const g = hypot(gx, gy) || 1.0;
    // 🔑 ボールを失った直後の奪い返し（tactics.counterPressS 秒の間）はプレス開始位置に関係なく寄せる
    const counterPress = sinceLossS < tactics.counterPressS;
    if (g > tactics.pressStartM && !counterPress) {
      // 🔑 プレスのスイッチが入っていない: いちばん近い1人がボールと自陣ゴールの間に立ってコースを切る
      if (press !== undefined) {
        orders.set(press.a.id, { x: ball.x + gx / g * CONTAIN_DIST_M, y: ball.y + gy / g * CONTAIN_DIST_M,
                                 pace: "JOG", role: "CONTAIN" });
      }
    } else {
      if (press !== undefined) {
        orders.set(press.a.id, { x: ball.x, y: ball.y, pace: "SPRINT", role: "PRESS" });
      }
      if (cover !== undefined) {
        orders.set(cover.a.id, {
          x: ball.x + gx / g * COVER_BEHIND_M, y: ball.y + gy / g * COVER_BEHIND_M,
          pace: "RUN", role: "COVER",
        });
      }
    }
    // 奪い返し: 寄せ役のほかに、次に早く着ける人も寄せる（合わせて tactics.counterPressPlayers 人）
    if (counterPress) {
      for (const r of ranked.filter((r) => r !== press).slice(0, Math.max(0, tactics.counterPressPlayers - 1))) {
        orders.set(r.a.id, { x: ball.x, y: ball.y, pace: "SPRINT", role: "PRESS" });
      }
    }
    if (g <= tactics.shieldZoneM) {
      // 🔑 シュートコースを塞ぐ: ボールとゴールの中心を結ぶ線の上に、左右へ少しずらして立つ
      const ux = gx / g;
      const uy = gy / g;
      const shields = ranked
        .filter((r) => r !== press && r.front && orders.get(r.a.id)!.role === "BLOCK")
        .slice(0, tactics.shieldCount);
      shields.forEach((r, i) => {
        const d = SHIELD_DISTS_M[i] ?? SHIELD_DISTS_M[SHIELD_DISTS_M.length - 1]!;
        const side = i % 2 === 0 ? 1.0 : -1.0;
        orders.set(r.a.id, {
          x: clamp(ball.x + ux * d - uy * side * SHIELD_SPREAD_M, 0.5, PITCH_LENGTH_M - 0.5),
          y: clamp(ball.y + uy * d + ux * side * SHIELD_SPREAD_M, 0.5, PITCH_WIDTH_M - 0.5),
          pace: "SPRINT", role: "SHIELD",
        });
      });
    }
  } else if (phase === "ATTACK" && holder !== null) {
    // 出し先の候補: その味方の位置の価値（xT）× 空きによる割引、が大きい順に tactics.outletCount 人（value.ts）
    const opponents = agents.filter((a) => a.team !== team);
    const scored = field
      .filter((a) => a.id !== holder.id && orders.get(a.id)!.role !== "TAKER")
      .map((a) => {
        const d = hypot(a.body.x - ball.x, a.body.y - ball.y);
        if (d < 5.0 || d > 45.0) return null;
        return { a, score: xtAt(team, a.body.x, a.body.y) * receiveFactor(openAt(opponents, a.body.x, a.body.y)) };
      })
      .filter((s): s is { a: Agent; score: number } => s !== null)
      .sort((p, q) => q.score - p.score || p.a.id - q.a.id);
    for (const s of scored.slice(0, tactics.outletCount)) {
      outlets.push(s.a.id);
      orders.get(s.a.id)!.role = "OUTLET";
    }
    // 🔑 裏へ走り込む役: 相手ゴールにいちばん近い前線の選手から tactics.runnerCount 人。
    //    裏にスペースがあるときだけ。行き先（ラインの裏）は選手AIが 0.2秒ごとにラインを見て出し直す
    if (restart === null) {
      const line = offsideLineX(team, ball.x, agents.map((a) => ({ team: a.team, x: a.body.x })));
      const goalLineX = dir > 0 ? PITCH_LENGTH_M : 0.0;
      if (Math.abs(goalLineX - line) >= RUN_SPACE_MIN_M) {
        // FW を相手ゴールに近い順に。足りなければ MF から同じ順で補う
        const nearer = (p: Agent, q: Agent): number => (q.body.x - p.body.x) * dir || p.id - q.id;
        const pick = (role: Agent["role"]): Agent[] =>
          field.filter((a) => a.id !== holder.id && a.role === role).sort(nearer);
        const attackers = [...pick("FW"), ...pick("MF")];
        for (const a of attackers.slice(0, tactics.runnerCount)) {
          const o = orders.get(a.id)!;
          o.role = "RUNNER";
          o.pace = "SPRINT";
          if (!outlets.includes(a.id)) outlets.push(a.id);
        }
      }
    }
    // 🔑 クロスの場面（サイドの深い位置）: 前線がニアポスト・ファーポスト・ペナルティスポットへ入る。
    //    コーナーキックもこの場面に入る（ボールがコーナーにある）
    const goalLineX = dir > 0 ? PITCH_LENGTH_M : 0.0;
    const side = ball.y >= PITCH_WIDTH_M / 2 ? 1.0 : -1.0;
    if (Math.abs(goalLineX - ball.x) <= CROSS_ZONE_DEPTH_M
        && Math.abs(ball.y - PITCH_WIDTH_M / 2) >= CROSS_ZONE_WIDE_M) {
      const spots: [number, number][] = [
        [goalLineX - dir * 5.0, PITCH_WIDTH_M / 2 + side * 3.0],    // ニアポスト
        [goalLineX - dir * 6.0, PITCH_WIDTH_M / 2 - side * 4.0],    // ファーポスト
        [goalLineX - dir * 11.0, PITCH_WIDTH_M / 2],                // ペナルティスポット
      ];
      const nearer = (p: Agent, q: Agent): number => (q.body.x - p.body.x) * dir || p.id - q.id;
      const taker = restart?.taker;
      const pick = (role: Agent["role"]): Agent[] =>
        field.filter((a) => a.id !== holder.id && a.id !== taker && a.role === role).sort(nearer);
      const attackers = [...pick("FW"), ...pick("MF")].slice(0, tactics.boxCount);
      attackers.forEach((a, i) => {
        const o = orders.get(a.id)!;
        [o.x, o.y] = spots[i]!;
        o.role = "BOX";
        o.pace = "RUN";
        if (!outlets.includes(a.id)) outlets.push(a.id);
      });
    }
  }
  return { phase, orders, outlets };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
