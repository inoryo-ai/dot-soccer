/**
 * プリセット全チームの平均スタッツを実測し、**現実の相場と並べて機械で判定する**。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ「並べて出す」だけでは足りないのか
 * ─────────────────────────────────────────────────────────────
 * 以前のこの道具は数字を表にして出すだけで、妥当かどうかは人が見て決めていた。
 * ループ#1で「1試合の奪い合い4,081回・走行191km」という**桁で狂った値**が出たが、
 * 例外は出ず試合も成立していたので、表を見た人が気づくまで分からなかった。
 *
 * 相場を知らないと「4,000回」が異常だと判断できない。
 * だから**期待レンジを持たせて、外れたら赤くする**。
 *
 * 🔴 期待レンジには必ず**出典**を書く。
 *    書けない数字は「監視のみ」に置き、判定に使わない（推測を基準にしない）。
 *
 * 使い方:
 *     node scripts/measure.ts          # 3シードで測って判定（終了コードで可否）
 *     node scripts/measure.ts 5        # シード数を増やす
 */

import { fileURLToPath } from "node:url";

import { combinations } from "../src/sim/batch.ts";
import * as C from "../src/sim/constants.ts";
import { play } from "../src/sim/engine.ts";
import type { MatchResult, MatchStatsOut } from "../src/sim/engine.ts";
import { PRESET_ORDER, buildPreset } from "../src/sim/presets.ts";
import { fmtF, hypot, ljust, mean, pyFloatStr, rjust } from "../src/sim/pymath.ts";

/** 1指標の期待レンジ。**出典が無いものはここに置かない。** */
export interface Expected {
  low: number;
  high: number;
  source: string;
}

const holds = (e: Expected, v: number): boolean => e.low <= v && v <= e.high;

// ------------------------------------------------------------------ 期待レンジ
//
// 🔴 ここの数字は「こうあってほしい」ではなく「現実のサッカーがこうである」。
//    変えるときは出典ごと変えること。出典なしで緩めたら、この道具は飾りになる。
//
// 出典:
//   [PL]   プレミアリーグ公式 — 決定率は 2003/04 以降の平均 10.30%、
//          2023/24 が記録的な高さで 11.88%
//          https://www.premierleague.com/en/news/4027257
//   [CIES] CIES Football Observatory 月報68 — 31リーグのフィールドプレーヤー
//          1チーム1試合あたり合計 99.9km。FIFA W杯2022 は総走行 108.1km
//          https://football-observatory.com/IMG/sites/mr/mr68/en/
//   [JL]   Jリーグ 1993年 180試合532得点＝2.96点/試合、1995年 364試合1,214得点＝3.34点/試合
//          （両チーム合計。1チームあたりは概ね 1.5 前後）
//          https://en.wikipedia.org/wiki/1993_J.League
export const EXPECTED: Readonly<Record<string, Expected>> = {
  goals: { low: 1.0, high: 1.9,
           source: "[JL] 両チーム合計 2.96〜3.34点/試合 → 1チームあたり 1.5 前後" },
  shots: { low: 9.0, high: 18.0,
           source: "[PL] 決定率 10.3% で 1.4点を取るのに要るシュート数から逆算（約13〜14本）" },
  conversion_pct: { low: 8.0, high: 13.0,
                    source: "[PL] 2003/04以降の平均 10.30%、2023/24 の最高 11.88%" },
  distance_km: { low: 95.0, high: 115.0,
                 source: "[CIES] 31リーグ平均 99.9km／FIFA W杯2022 総走行 108.1km（1チーム1試合）" },
  possession_pct: { low: 35.0, high: 65.0,
                    source: "定義上 両チームの合計が100%。どのチームも50%付近に収まるはず" },
};

// --------------------------------------------------------------- 判定の仕方
//
// 🔴 **相場は「リーグの平均」なので、平均と比べる。**
//    2026-10-01 まではチーム1つずつを相場と比べていたが、これは測り方の間違い。
//    プリセット6チームは「1種類のカードだけ20回」という**極端な型**で、
//    シュートだけ20回積んだチームと、実在リーグの平均を直接比べても意味がない。
//    実測でも、どう調整しても6チームの幅（例: 決定率 7.8〜14.6%）が
//    相場の幅（8〜13%）より広くなり、**ゲーム側を壊さないと緑にならない**状態だった。
//
// 🔑 そのかわり2段構えにする。
//      ①**平均**が相場に入っているか  ← ゲーム全体が現実的か
//      ②**どのチームも壊れていないか** ← 相場の幅1つぶん外れたら壊れている
//    ②を入れないと、平均だけ合わせて中身がめちゃくちゃでも緑になる。
export const OUTLIER_MARGIN = 1.0;   // 相場の幅の何倍まで外れてよいか（1つぶん）

// 🔴 既知の赤。**空にするのがバランス調整のループの終了条件。**
//    2026-10-01 のループ#5/#6 で空になった。増やすときは報告書に理由を書く。
export const KNOWN_RED: ReadonlySet<string> = new Set();

// 🔑 相場の裏付けが取れなかったもの。**判定には使わない**が、表には出す。
//    （出典を見つけたら EXPECTED へ移す。推測でレンジを置かないこと）
export const WATCH_ONLY = [
  "passes", "pass_success_pct", "tackles_won", "duels_lost_pct", "beaten_behind",
  "shots_against", "stamina_low_players", "win_pct",
] as const;

const RAW_KEYS = [
  "shots", "goals", "passes", "pass_success_pct", "duels", "duels_lost",
  "tackles_won", "distance_km", "beaten_behind", "possession_pct",
  "shots_against", "stamina_low_players",
] as const satisfies readonly (keyof MatchStatsOut)[];

export const LABELS: Readonly<Record<string, string>> = {
  goals: "得点", shots: "シュート", conversion_pct: "決定率%",
  shots_against: "被シュート", passes: "パス", pass_success_pct: "パス成功%",
  tackles_won: "奪取", duels_lost_pct: "競り負け%", beaten_behind: "裏を取られ",
  distance_km: "走行km", possession_pct: "支配%", stamina_low_players: "息切れ人数",
  win_pct: "勝率%",
};

export type Rows = Record<string, Record<string, number>>;

// ------------------------------------------------------------ 攻撃の到達点
//
// 🔴 「ゴール前で攻撃が止まる」（2026-10-02 オーナー指摘・decisions.md）を毎回測る。
//    前回は使い捨ての計測で 71.3% が 16.5〜24m に溜まっていると分かったが、
//    道具が残っていなかったので、直したかどうかを同じ物差しで確かめられなかった。
//
// 🔑 ゴールから 24m 以内（`SHOOT_RANGE_M`）で攻めている側が持っている時間を、
//    距離の帯ごとに割合で出す。再生用の記録（`record=true`）から数えるので、
//    試合の結果には一切触れない（記録は乱数を引かない・replay.test.ts）。
//    相場の出典が無いので**監視のみ**。判定には使わない。
export const REACH_BANDS: readonly [number, number, string][] = [
  [0.0, 6.0, "0〜6m"],
  [6.0, 11.0, "6〜11m"],
  [11.0, 16.5, "11〜16.5m"],
  [16.5, 24.0, "16.5〜24m"],
];

/** 1試合の記録から、攻めている側の保持をゴールからの距離の帯ごとに数える。 */
export function reachCounts(result: MatchResult): number[] {
  const counts = REACH_BANDS.map(() => 0);
  const rp = result.replay;
  if (rp === undefined) throw new Error("record=true で回した試合を渡すこと");
  const k = rp.coord_scale;
  const homePlayers = rp.roster.filter((r) => r.team === 0).length;
  rp.frames.forEach((f, i) => {
    const owner = f[2]!;
    if (owner < 0) return;
    const tick = i * rp.sample_ticks;
    const team = owner < homePlayers ? 0 : 1;
    // 🔑 前半はホームが +x へ攻め、後半はエンドを入れ替える（engine.ts `run`）
    const homeDir = tick < C.TICKS_PER_HALF ? 1 : -1;
    const dir = team === 0 ? homeDir : -homeDir;
    const goalX = dir > 0 ? rp.pitch[0] : 0.0;
    const d = hypot(goalX - f[0]! / k, rp.pitch[1] / 2 - f[1]! / k);
    const band = REACH_BANDS.findIndex(([lo, hi]) => lo <= d && d < hi);
    if (band >= 0) counts[band]! += 1;
  });
  return counts;
}

/** プリセット総当たりを走らせ、チームごとの平均値を返す（3つ目は攻撃の到達点の帯ごとの数）。 */
export function measure(reps: number): [Rows, number, number[]] {
  const names = [...PRESET_ORDER];
  const teams = new Map(names.map((n) => [n, buildPreset(n)]));
  const agg: Record<string, Record<string, number[]>> = {};
  for (const n of names) agg[n] = Object.fromEntries(RAW_KEYS.map((k) => [k, [] as number[]]));
  let nMatches = 0;
  const reach = REACH_BANDS.map(() => 0);
  // 勝ち点の割合（勝ち1・引き分け0.5）。相性 [7] と同じ数え方の粗い版（監視のみ）
  const wins: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, [] as number[]]));

  for (const [home, away] of combinations(names)) {
    for (let off = 0; off < reps; off++) {
      const result = play(teams.get(home)!.clone(), teams.get(away)!.clone(), 1000 + off, false,
                          true);
      nMatches += 1;
      reachCounts(result).forEach((c, i) => { reach[i]! += c; });
      [home, away].forEach((n, i) => {
        for (const k of RAW_KEYS) agg[n]![k]!.push(result.stats[i]![k]);
        const [mine, theirs] = [result.score[i]!, result.score[1 - i]!];
        wins[n]!.push(mine > theirs ? 1.0 : mine === theirs ? 0.5 : 0.0);
      });
    }
  }

  const out: Rows = {};
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  for (const n of names) {
    const s = agg[n]!;
    const row: Record<string, number> = Object.fromEntries(RAW_KEYS.map((k) => [k, mean(s[k]!)]));
    // 🔑 率は「平均の平均」ではなく合計から出す（試合ごとの本数が違うため）
    row.conversion_pct = 100.0 * sum(s.goals!) / Math.max(1.0, sum(s.shots!));
    row.duels_lost_pct = 100.0 * sum(s.duels_lost!) / Math.max(1.0, sum(s.duels!));
    row.win_pct = 100.0 * mean(wins[n]!);
    out[n] = row;
  }
  return [out, nMatches, reach];
}

export const teamValues = (rows: Rows, key: string): number[] =>
  Object.values(rows).map((r) => r[key]!);
export const meanOf = (rows: Rows, key: string): number => mean(teamValues(rows, key));

/** **平均**が相場を外れている指標名の集合。 */
export function outOfRange(rows: Rows): Set<string> {
  return new Set(Object.entries(EXPECTED)
    .filter(([key, e]) => !holds(e, meanOf(rows, key))).map(([key]) => key));
}

/** 壊れているチーム。相場の幅1つぶん外れたら、平均が合っていても壊れている。 */
export function outliers(rows: Rows): string[] {
  const out: string[] = [];
  for (const [key, e] of Object.entries(EXPECTED)) {
    const slack = (e.high - e.low) * OUTLIER_MARGIN;
    for (const [name, row] of Object.entries(rows)) {
      const v = row[key]!;
      if (v < e.low - slack || v > e.high + slack) {
        out.push(`${name} の${LABELS[key]} ${fmtF(v, 2)}`
                 + `（許容 ${fmtF(e.low - slack, 1)}〜${fmtF(e.high + slack, 1)}）`);
      }
    }
  }
  return out;
}

function describe(rows: Rows, key: string): string {
  const e = EXPECTED[key]!;
  const values = teamValues(rows, key);
  return (`${LABELS[key]}: 平均 ${fmtF(meanOf(rows, key), 2)}`
          + ` / 相場 ${pyFloatStr(e.low)}〜${pyFloatStr(e.high)}（${e.source}）`
          + `\n      各チーム ${fmtF(Math.min(...values), 2)}〜${fmtF(Math.max(...values), 2)}`);
}

/**
 * [止めるべき問題, 既知の赤のままの項目] を返す。
 *
 * 🔴 止めるのは3つ。
 *    ①**平均が新しく外れた**（KNOWN_RED に無い）
 *    ②**相場に戻った**のに KNOWN_RED に残っている（消さないと次を見逃す）
 *    ③**壊れているチームがある**（平均が合っていても中身が壊れている）
 */
export function judge(rows: Rows): [string[], string[]] {
  const outside = outOfRange(rows);
  const blocking = [...outside].filter((k) => !KNOWN_RED.has(k)).sort()
    .map((key) => `（平均が新しく外れた）${describe(rows, key)}`);
  blocking.push(...[...KNOWN_RED].filter((k) => !outside.has(k)).sort()
    .map((key) => `（相場に戻った）${LABELS[key]}: KNOWN_RED から ${key} を消すこと`));
  blocking.push(...outliers(rows).map((item) => `（チームが壊れている）${item}`));
  const stillRed = [...outside].filter((k) => KNOWN_RED.has(k)).sort()
    .map((key) => describe(rows, key));
  return [blocking, stillRed];
}

export function main(reps = 3, out: (line?: string) => void = (l = "") => console.log(l)): number {
  const [rows, nMatches, reach] = measure(reps);
  out(`読んだ試合数: ${nMatches}（プリセット${Object.keys(rows).length}チーム総当たり × ${reps}シード）\n`);

  const shown = ["goals", "shots", "conversion_pct", "shots_against", "passes",
                 "pass_success_pct", "tackles_won", "duels_lost_pct", "beaten_behind",
                 "distance_km", "possession_pct", "stamina_low_players", "win_pct"];
  out(ljust("チーム", 10) + shown.map((k) => rjust(LABELS[k]!, 12)).join(""));
  for (const [name, row] of Object.entries(rows)) {
    out(ljust(name, 10) + shown.map((k) => rjust(fmtF(row[k]!, 2), 12)).join(""));
  }

  const outside = outOfRange(rows);
  out("\n--- 相場との照合（**平均**で判定・出典つき） ---");
  for (const [key, e] of Object.entries(EXPECTED)) {
    const values = teamValues(rows, key);
    const mark = !outside.has(key) ? "✅" : (KNOWN_RED.has(key) ? "🟡" : "🔴");
    out(`  ${mark} ${ljust(LABELS[key]!, 8)} 平均 ${rjust(fmtF(meanOf(rows, key), 2), 7)}`
        + `  相場 ${pyFloatStr(e.low)}〜${pyFloatStr(e.high)}`
        + `  （各チーム ${fmtF(Math.min(...values), 2)}〜${fmtF(Math.max(...values), 2)}）`);
    out(`       出典: ${e.source}`);
  }

  out("\n--- 監視のみ（相場の出典が取れていないので判定に使わない） ---\n"
      + `  ${WATCH_ONLY.map((k) => LABELS[k]).join(", ")}`);

  const reachTotal = reach.reduce((a, b) => a + b, 0);
  out(`\n--- 攻撃の到達点（ゴールから24m以内で攻めている側が持っていた記録 ${reachTotal}コマ・監視のみ） ---`);
  REACH_BANDS.forEach(([, , label], i) => {
    out(`  ${ljust(label, 10)} ${rjust(String(reach[i]), 6)}コマ  `
        + `${rjust(fmtF(100.0 * reach[i]! / Math.max(1, reachTotal), 1), 5)}%`);
  });

  const [blocking, stillRed] = judge(rows);
  if (stillRed.length > 0) {
    out(`\n🟡 前から相場を外れたまま（バランス調整のループで直す）— ${stillRed.length}件:`);
    for (const item of stillRed) out(`    - ${item}`);
  }
  if (blocking.length > 0) {
    out(`\n🔴 止めるべき変化が ${blocking.length}件:`);
    for (const item of blocking) out(`    - ${item}`);
    return 1;
  }
  out("\n✅ 平均はすべて相場の内側。壊れているチームも無し");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reps = process.argv[2] !== undefined ? Number.parseInt(process.argv[2], 10) : 3;
  process.exitCode = main(reps);
}
