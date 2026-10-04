/**
 * 選手AI（効用・D-41/D-42）の中身を覗く診断。**判定はしない**（判定は `measure.ts`）。
 *
 *     node scripts/diagnose_ai.ts          # プリセット総当たり × 1シード
 *     node scripts/diagnose_ai.ts 3        # シード数を増やす
 *
 * 🔴 なぜ要るのか: 得点が相場の4倍に跳ねたとき、`measure.ts` は「外れた」とは言うが
 *    「どこから撃って、どう点になったか」は言わない。当て推量でつまみを回すと
 *    往復が止まらない（台帳・黒瀬「指標が3つ以上絡む調整は手で回さない」）。
 *
 * 🔑 試合の結果には触れない。`Match` の状態と、ログの経過を読むだけ
 *    （判断の採点 `onBallChoices` は乱数を引かないので、覗いても試合は変わらない）。
 */

import { fileURLToPath } from "node:url";

import { combinations } from "../src/sim/batch.ts";
import * as C from "../src/sim/constants.ts";
import { Match } from "../src/sim/engine.ts";
import type { Actor } from "../src/sim/engine.ts";
import { PRESET_ORDER, buildPreset } from "../src/sim/presets.ts";
import { fmtF, hypot, ljust, rjust } from "../src/sim/pymath.ts";
import { chooseBest } from "../src/sim/utility.ts";

const SHOT_BANDS: readonly [number, number][] = [[0, 6], [6, 11], [11, 16.5], [16.5, 24]];

export interface Diagnosis {
  matches: number;
  onBall: Map<string, number>;
  /** [帯ごとの本数, 帯ごとの得点] */
  shots: [number[], number[]];
  /** 攻撃時・守備時の意思ごとの「人×秒」 */
  intents: { attack: Map<string, number>; defend: Map<string, number> };
  /**
   * 運ぶと決めたときの「持ち続けられる確率」の予測と実際
   * （予測の帯 → [件数, 予測の和, 実際に失わなかった数]）。
   * 🔴 D-42 で、予測 0.75 が実際は 0.36 だった（奪い合いを見積もりに入れていなかった）。
   *    物差しが現実とずれると、AIは「数値に操られて」撃たずに運び続ける。予測と実際が近いことを毎回見る。
   */
  keep: Map<string, [number, number, number]>;
}

interface Watch {
  team: number;
  key: string;
  pred: number;
}

export function diagnose(reps: number): Diagnosis {
  const names = [...PRESET_ORDER];
  const onBall = new Map<string, number>();
  const shots: [number[], number[]] = [SHOT_BANDS.map(() => 0), SHOT_BANDS.map(() => 0)];
  const intents = { attack: new Map<string, number>(), defend: new Map<string, number>() };
  const keep = new Map<string, [number, number, number]>();
  let matches = 0;
  const bump = (m: Map<string, number>, k: string, n = 1): void => {
    m.set(k, (m.get(k) ?? 0) + n);
  };
  const record = (w: Watch, lost: boolean): void => {
    const b = keep.get(w.key) ?? [0, 0, 0];
    b[0] += 1;
    b[1] += w.pred;
    if (!lost) b[2] += 1;
    keep.set(w.key, b);
  };

  for (const [home, away] of combinations(names)) {
    for (let off = 0; off < reps; off++) {
      const m = new Match(buildPreset(home), buildPreset(away), 1000 + off, true);
      // 🔑 1秒ごとに意思を数えたいので、run() と同じ手順を外から1歩ずつ回す
      const mm = m as any;
      mm.resetPositions(0);
      mm.evaluatePolicies();
      // 前の秒に運んだ人（この秒の奪い合いで奪われるかを見届ける）
      let watching: Watch | null = null;
      for (m.tick = 0; m.tick < C.TICKS_PER_MATCH; m.tick++) {
        if (m.tick === C.TICKS_PER_HALF) {
          for (const ts of m.teams) ts.direction *= -1;
          mm.resetPositions(1);
          watching = null;
        }
        if (m.tick % C.POLICY_CHECK_INTERVAL === 0) {
          mm.evaluatePolicies();
          mm.considerSubstitutions();
        }
        if (m.restart !== null) {
          if (watching !== null) record(watching, false);
          watching = null;
          mm.stepRestart();
          continue;
        }
        mm.moveAll();
        // 運ぶ判断の予測を拾う（この秒の勝負と、次の秒の奪い合いを越えて持てるか）
        let decided: Watch | null = null;
        const holder: Actor | null = m.owner;
        if (holder !== null && m.action_cd === 0) {
          const best = chooseBest(mm.onBallChoices(holder, m.teams[holder.team_idx]!)) as any;
          if (best.action.kind === "DRIBBLE") {
            const pred: number = best.score.terms
              .find((t: { label: string }) => t.label === "持ち続けられる確率").value;
            decided = { team: holder.team_idx, key: fmtF(Math.floor(pred * 10) / 10, 1), pred };
          }
        }
        // 撃った位置を残すため、ボール処理の直前の保持者と位置を覚える
        const before = holder === null ? null
          : { team: holder.team_idx, x: holder.x, y: holder.y,
              shots: m.teams[holder.team_idx]!.stats.shots,
              goals: m.teams[holder.team_idx]!.stats.goals };
        const eventsBefore = m.events.length;
        mm.resolveBall();
        // 前の秒に運んだ人が、この秒の奪い合い（detail が「〜 から」）で奪われたか
        if (watching !== null) {
          const contestLost = m.events.slice(eventsBefore)
            .some((e) => e.type === "奪取" && e.detail.endsWith(" から"));
          record(watching, contestLost);
          watching = null;
        }
        if (decided !== null) {
          // この秒のドリブルの勝負で奪われたなら、その場で失敗。持てたなら次の秒の奪い合いを見届ける
          if (m.owner === null || m.owner.team_idx !== decided.team) record(decided, true);
          else watching = decided;
        }
        if (before !== null) {
          const ts = m.teams[before.team]!;
          if (ts.stats.shots > before.shots) {
            const gx = ts.targetGoalX();
            // 撃った人は撃つ直前の位置（撃つ判断の間は動かない）
            const d = hypot(gx - before.x, C.PITCH_Y / 2 - before.y);
            const band = SHOT_BANDS.findIndex(([lo, hi]) => lo <= d && d < hi);
            if (band >= 0) {
              shots[0][band]! += 1;
              if (ts.stats.goals > before.goals) shots[1][band]! += 1;
            }
          }
        }
        const ownerTeam = m.owner === null ? null : m.owner.team_idx;
        for (const side of m.actors) {
          for (const a of side) {
            if (a === m.owner || a.pos === "GK" || ownerTeam === null) continue;
            bump(a.team_idx === ownerTeam ? intents.attack : intents.defend, a.intent);
          }
        }
      }
      for (const [k, v] of m.onBallCounts) bump(onBall, k, v);
      matches += 1;
    }
  }
  return { matches, onBall, shots, intents, keep };
}

function share(m: Map<string, number>): string {
  const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
  return [...m.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${fmtF(100 * v / total, 1)}%`).join(" / ");
}

export function main(reps = 1, out: (line?: string) => void = (l = "") => console.log(l)): void {
  const d = diagnose(reps);
  out(`試合数: ${d.matches}`);
  out("\n--- ボールを持った人の判断（1試合あたり） ---");
  for (const [k, v] of [...d.onBall.entries()].sort()) {
    out(`  ${ljust(k, 8)} ${rjust(fmtF(v / d.matches, 1), 7)}`);
  }
  out("\n--- 撃った距離（両チーム合計・1試合あたり） ---");
  SHOT_BANDS.forEach(([lo, hi], i) => {
    const n = d.shots[0][i]!;
    const g = d.shots[1][i]!;
    out(`  ${ljust(`${lo}〜${hi}m`, 10)} 本数 ${rjust(fmtF(n / d.matches, 2), 6)}`
        + `  得点 ${rjust(fmtF(g / d.matches, 2), 5)}  決定率 ${rjust(fmtF(100 * g / Math.max(1, n), 1), 5)}%`);
  });
  out("\n--- 運ぶときの「持ち続けられる確率」の予測と実際（ずれていたら物差しが現実と合っていない） ---");
  for (const [k, [n, p, kept]] of [...d.keep.entries()].sort()) {
    out(`  予測 ${k}台  ${rjust(String(n), 5)}件  予測 ${fmtF(p / n, 2)}  実際 ${fmtF(kept / n, 2)}`);
  }
  out("\n--- 意思の内訳（GKと保持者を除く人×秒） ---");
  out(`  攻撃時: ${share(d.intents.attack)}`);
  out(`  守備時: ${share(d.intents.defend)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] !== undefined ? Number.parseInt(process.argv[2], 10) : 1);
}

// ------------------------------------------------------------ 型の個性が動きに出ているか
//
// 🔴 要件定義書 §6 の核「特訓の違いで…試合中の動きが変わること」。タイプが変わることは検査していたが、
//    **試合の中で動きが違うこと**は検査していなかった。D-43/D-44 の途中で、裏へ走る意思が全体の 0.3% まで消え、
//    プリセットの個性が動きに出ないまま勝率だけがそろっていた（そろったのは個性が消えたから）。

/** 型ごとの「らしい」意思（攻撃時か守備時か）。 */
export const SIGNATURE: Readonly<Record<string, readonly [string, "attack" | "defend"]>> = {
  "走力型": ["OVERLAP", "attack"],
  "裏抜け型": ["RUN_BEHIND", "attack"],
  "パス型": ["SUPPORT", "attack"],
  "プレス型": ["COVER", "defend"],
  "堅守型": ["MARK", "defend"],
};

/** そのチームが、攻撃時・守備時に各意思を選んでいた割合（GKと保持者を除く人×秒）。 */
export function teamIntentShares(team: string, opponent: string, seeds: readonly number[]):
    { attack: Map<string, number>; defend: Map<string, number> } {
  const attack = new Map<string, number>();
  const defend = new Map<string, number>();
  for (const seed of seeds) {
    const m = new Match(buildPreset(team), buildPreset(opponent), seed, false);
    const mm = m as any;
    mm.resetPositions(0);
    mm.evaluatePolicies();
    for (m.tick = 0; m.tick < C.TICKS_PER_MATCH; m.tick++) {
      if (m.tick === C.TICKS_PER_HALF) {
        for (const ts of m.teams) ts.direction *= -1;
        mm.resetPositions(1);
      }
      if (m.tick % C.POLICY_CHECK_INTERVAL === 0) {
        mm.evaluatePolicies();
        mm.considerSubstitutions();
      }
      if (m.restart !== null) {
        mm.stepRestart();
        continue;
      }
      mm.moveAll();
      mm.resolveBall();
      if (m.owner === null) continue;
      const mine = m.owner.team_idx === 0;
      for (const a of m.actors[0]!) {
        if (a === m.owner || a.pos === "GK") continue;
        const bucket = mine ? attack : defend;
        bucket.set(a.intent, (bucket.get(a.intent) ?? 0) + 1);
      }
    }
  }
  const norm = (mp: Map<string, number>): Map<string, number> => {
    const total = [...mp.values()].reduce((x, y) => x + y, 0) || 1;
    return new Map([...mp.entries()].map(([k, v]) => [k, v / total]));
  };
  return { attack: norm(attack), defend: norm(defend) };
}
