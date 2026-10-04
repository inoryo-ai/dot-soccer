/**
 * 選手AI（効用・D-41）の中身を覗く診断。**判定はしない**（判定は `measure.ts`）。
 *
 *     node scripts/diagnose_ai.ts          # プリセット総当たり × 1シード
 *     node scripts/diagnose_ai.ts 3        # シード数を増やす
 *
 * 🔴 なぜ要るのか: 得点が相場の4倍に跳ねたとき、`measure.ts` は「外れた」とは言うが
 *    「どこから撃って、どう点になったか」は言わない。当て推量でつまみを回すと
 *    往復が止まらない（台帳・黒瀬「指標が3つ以上絡む調整は手で回さない」）。
 *
 * 🔑 試合の結果には触れない。`Match` の公開された状態と、ログの経過を読むだけ。
 */

import { fileURLToPath } from "node:url";

import { combinations } from "../src/sim/batch.ts";
import * as C from "../src/sim/constants.ts";
import { Match } from "../src/sim/engine.ts";
import { PRESET_ORDER, buildPreset } from "../src/sim/presets.ts";
import { fmtF, hypot, ljust, rjust } from "../src/sim/pymath.ts";

const SHOT_BANDS: readonly [number, number][] = [[0, 6], [6, 11], [11, 16.5], [16.5, 24]];

export interface Diagnosis {
  matches: number;
  onBall: Map<string, number>;
  /** [帯ごとの本数, 帯ごとの得点] */
  shots: [number[], number[]];
  /** 攻撃時・守備時の意思ごとの「人×秒」 */
  intents: { attack: Map<string, number>; defend: Map<string, number> };
}

export function diagnose(reps: number): Diagnosis {
  const names = [...PRESET_ORDER];
  const onBall = new Map<string, number>();
  const shots: [number[], number[]] = [SHOT_BANDS.map(() => 0), SHOT_BANDS.map(() => 0)];
  const intents = { attack: new Map<string, number>(), defend: new Map<string, number>() };
  let matches = 0;
  const bump = (m: Map<string, number>, k: string, n = 1): void => {
    m.set(k, (m.get(k) ?? 0) + n);
  };

  for (const [home, away] of combinations(names)) {
    for (let off = 0; off < reps; off++) {
      const m = new Match(buildPreset(home), buildPreset(away), 1000 + off, true);
      // 🔑 1秒ごとに意思を数えたいので、run() と同じ手順を外から1歩ずつ回す
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
        } else {
          mm.moveAll();
          // 撃った位置を残すため、ボール処理の直前の保持者と位置を覚える
          const owner = m.owner;
          const before = owner === null ? null
            : { team: owner.team_idx, x: owner.x, y: owner.y,
                shots: m.teams[owner.team_idx]!.stats.shots,
                goals: m.teams[owner.team_idx]!.stats.goals };
          mm.resolveBall();
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
      }
      for (const [k, v] of m.onBallCounts) bump(onBall, k, v);
      matches += 1;
    }
  }
  return { matches, onBall, shots, intents };
}

function share(m: Map<string, number>): string {
  const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
  return [...m.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${fmtF(100 * v / total, 1)}%`).join(" / ");
}

export function main(reps = 1, out: (line?: string) => void = (l = "") => console.log(l)): void {
  const d = diagnose(reps);
  out(`試合数: ${d.matches}`);
  out(`\n--- ボールを持った人の判断（1試合あたり） ---`);
  for (const [k, v] of [...d.onBall.entries()].sort()) {
    out(`  ${ljust(k, 8)} ${rjust(fmtF(v / d.matches, 1), 7)}`);
  }
  out(`\n--- 撃った距離（両チーム合計・1試合あたり） ---`);
  SHOT_BANDS.forEach(([lo, hi], i) => {
    const n = d.shots[0][i]!;
    const g = d.shots[1][i]!;
    out(`  ${ljust(`${lo}〜${hi}m`, 10)} 本数 ${rjust(fmtF(n / d.matches, 2), 6)}`
        + `  得点 ${rjust(fmtF(g / d.matches, 2), 5)}  決定率 ${rjust(fmtF(100 * g / Math.max(1, n), 1), 5)}%`);
  });
  out(`\n--- 意思の内訳（GKと保持者を除く人×秒） ---`);
  out(`  攻撃時: ${share(d.intents.attack)}`);
  out(`  守備時: ${share(d.intents.defend)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] !== undefined ? Number.parseInt(process.argv[2], 10) : 1);
}
