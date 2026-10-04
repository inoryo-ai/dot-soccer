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
//   [OPTA-TO] The Analyst「Defending Against Dribblers」— プレミアリーグ 2024-25 の仕掛けの成功率 平均 36.7%
//          https://theanalyst.com/articles/premier-league-best-worst-one-v-one-defenders
//   [FB-TO] FBref の集計（fivda「Premier League's Top Dribblers 2024-25」）— 仕掛けの成功率 平均 43.7%、
//          仕掛けの回数 1チーム1試合 12.9（最少）〜21（最多）
//          https://fivda.com/2025/01/24/premier-league-top-dribblers-2025/
//   [FB-DEF] FBref「2024-2025 Premier League Defensive Action Stats」— タックル成功（TklW）1チーム1シーズン 299〜493（38試合で 7.9〜13.0/試合）
//          https://fbref.com/en/comps/9/2024-2025/defense/2024-2025-Premier-League-Stats
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
  // 🔑 D-49: 刻みを細かくしたら、仕掛けとタックルが現実の数倍になった（受けた直後に自動で仕掛けていた）。物理の部品を出典に合わせる
  takeons: { low: 10.0, high: 25.0,
            source: "[FB-TO] 仕掛けの回数 1チーム1試合 12.9〜21" },
  takeon_success_pct: { low: 30.0, high: 50.0,
                       source: "[OPTA-TO] 36.7% ／ [FB-TO] 43.7%" },
  tackles: { low: 6.0, high: 16.0,
            source: "[FB-DEF] タックル成功 7.9〜13.0/試合" },
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
  "shots_against", "stamina_low_players", "takeons", "takeons_won", "tackles",
] as const satisfies readonly (keyof MatchStatsOut)[];

export const LABELS: Readonly<Record<string, string>> = {
  goals: "得点", shots: "シュート", conversion_pct: "決定率%",
  shots_against: "被シュート", passes: "パス", pass_success_pct: "パス成功%",
  tackles_won: "奪取", duels_lost_pct: "競り負け%", beaten_behind: "裏を取られ",
  distance_km: "走行km", possession_pct: "支配%", stamina_low_players: "息切れ人数",
  win_pct: "勝率%", takeons: "仕掛け", takeons_won: "仕掛け成功", takeon_success_pct: "仕掛け成功%",
  tackles: "タックル",
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

// ------------------------------------------------------- 空いたゴールへ撃てたか
//
// 🔴 2026-10-04 オーナー指摘「ゴール前でゴールが完全に空いていても、選手が止まってシュートまで辿り着けない」。
//    得点・シュート数・決定率がすべて相場の内側でも起きていた＝**平均の指標では見えない**ので、専用に数える。
//
// 🔑 「空いている」＝ボールとゴールの真ん中を結ぶ帯（幅 `C.PASS_LANE_WIDTH_M`）に相手のフィールド選手が
//    1人もいない（GKだけ）。「完全に空いた」＝さらに保持者の `OPEN_GOAL_ALONE_M` 以内に相手が1人もいない。
//    そこから同じチームが持ち続けている間に撃てたかを、**ゴールからの距離の帯ごとに**数える。
// 🔴 最初は「30m以内」をひとまとめにしていた。撃つのが現実的でない 24〜30m が場面の8割を占め、
//    ゴール前の振る舞いが平均に埋もれた（本番の版でもゴール前は 79〜100% 撃てていて、
//    差が出ていたのはエリアの外 16.5〜24m だった）。だから帯で分けて、帯ごとの床を置く。
//    記録（record）と経過（log）を読むだけなので、試合の結果には触れない。監視のみ。
export const OPEN_GOAL_BANDS: readonly [number, number, string][] = [
  [0.0, 16.5, "ゴール前（エリア内）"],
  [16.5, 24.0, "エリアの外"],
  [24.0, 30.0, "遠目"],
];
export const OPEN_GOAL_WINDOW = 12;
export const OPEN_GOAL_ALONE_M = 5.0;
// 🔑 掃き出し（sweep.ts）で、「完全に空いた」場面から撃てた割合がこれを下回る設定を罰する（帯ごと・遠目は罰しない）。
//    現実の出典は無い（オーナーの要求そのもの）ので measure の判定には使わない。
//    本番の版（2026-10-04 時点）は ゴール前 79% ／ エリアの外 31%
export const OPEN_GOAL_SHOT_FLOORS: readonly number[] = [0.8, 0.45, 0.0];

/**
 * 帯ごとに [空いた場面, 撃てた, 完全に空いた場面, 撃てた] を並べた配列（帯の数×4）。
 * `record=true, log=true` で回した試合を渡す。
 */
export function openGoalCounts(result: MatchResult): number[] {
  const rp = result.replay;
  if (rp === undefined) throw new Error("record=true で回した試合を渡すこと");
  const k = rp.coord_scale;
  const nHome = rp.roster.filter((r) => r.team === 0).length;
  const shotTicks = [new Set<number>(), new Set<number>()];
  for (const e of result.events) {
    if (e.type !== "シュート" && e.type !== "ゴール") continue;
    // 撃った刻みを、その刻みを含むコマの番号にする（1秒刻みなら刻みそのもの）
    shotTicks[e.team === result.teams[0] ? 0 : 1]!.add(frameBefore(rp, e.tick) + 1);
  }
  const teamOf = (owner: number): number => (owner < nHome ? 0 : 1);
  const counts = new Array<number>(OPEN_GOAL_BANDS.length * 4).fill(0);
  let i = 0;
  while (i < rp.frames.length) {
    const f = rp.frames[i]!;
    const owner = f[2]!;
    if (owner < 0) { i += 1; continue; }
    const team = teamOf(owner);
    const tick = i * rp.sample_ticks;
    const homeDir = tick < C.TICKS_PER_HALF ? 1 : -1;
    const gx = (team === 0 ? homeDir : -homeDir) > 0 ? rp.pitch[0] : 0.0;
    const gy = rp.pitch[1] / 2;
    const bx = f[0]! / k;
    const by = f[1]! / k;
    const d = hypot(gx - bx, gy - by);
    const band = OPEN_GOAL_BANDS.findIndex(([lo, hi]) => lo <= d && d < hi);
    if (band < 0 || !laneClear(rp, f, team, bx, by, gx, gy)) {
      i += 1;
      continue;
    }
    const alone = !rp.roster.some((r, p) => r.team !== team
      && hypot(f[3 + p * 2]! / k - bx, f[4 + p * 2]! / k - by) <= OPEN_GOAL_ALONE_M);
    // 同じチームが持ち続けている間（こぼれ球の1コマは許す）に撃てたか
    let j = i;
    let hit = false;
    while (j < rp.frames.length && j - i <= OPEN_GOAL_WINDOW) {
      if (shotTicks[team]!.has(j)) { hit = true; break; }
      const o = rp.frames[j]![2]!;
      if (o >= 0 && teamOf(o) !== team) break;
      j += 1;
    }
    counts[band * 4]! += 1;
    if (hit) counts[band * 4 + 1]! += 1;
    if (alone) counts[band * 4 + 2]! += 1;
    if (alone && hit) counts[band * 4 + 3]! += 1;
    i = Math.max(j, i + 1) + 1;    // 同じ場面を二重に数えない
  }
  return counts;
}

/** 帯ごとの「完全に空いた場面から撃てた割合」。 */
export function openGoalRates(counts: readonly number[]): number[] {
  return OPEN_GOAL_BANDS.map((_, b) => counts[b * 4 + 3]! / Math.max(1, counts[b * 4 + 2]!));
}

/** ボールからゴールの真ん中への帯に、相手のフィールド選手がいないか。 */
function laneClear(rp: NonNullable<MatchResult["replay"]>, f: number[], team: number,
                   bx: number, by: number, gx: number, gy: number): boolean {
  const k = rp.coord_scale;
  const vx = gx - bx;
  const vy = gy - by;
  const ln2 = vx * vx + vy * vy;
  for (let p = 0; p < rp.roster.length; p++) {
    const r = rp.roster[p]!;
    if (r.team === team || r.pos === "GK") continue;
    const ox = f[3 + p * 2]! / k;
    const oy = f[4 + p * 2]! / k;
    const t = ((ox - bx) * vx + (oy - by) * vy) / ln2;
    if (t <= 0.0 || t >= 1.0) continue;
    if (hypot(ox - (bx + vx * t), oy - (by + vy * t)) <= C.PASS_LANE_WIDTH_M) return false;
  }
  return true;
}

// ----------------------------------------------------------- 攻撃の流れ（漏斗）
//
// 🔑 「攻撃の回数 → ゴールから24m以内への侵入 → シュート」を数える（D-42・監視のみ）。
//    シュートが相場より多いとき、原因が「攻撃の回数が多い（奪い合いが多すぎる）」のか
//    「入ったらほぼ必ず撃つ（物差しが待つ価値を持っていない）」のかを分けるため。
//    実測で 1チーム1試合 攻撃176回・侵入あたりシュート 0.90 だった（現実はおよそ100回・0.3〜0.4）。
//    相場の出典が取れていないので判定には使わない。

/** [攻撃の回数, 24m以内への侵入, 保持していたコマ数]。 */
export function funnelCounts(result: MatchResult): [number, number, number] {
  const rp = result.replay;
  if (rp === undefined) throw new Error("record=true で回した試合を渡すこと");
  const k = rp.coord_scale;
  const nHome = rp.roster.filter((r) => r.team === 0).length;
  let possessions = 0;
  let entries = 0;
  let held = 0;
  let current = -1;
  let inZone = false;
  rp.frames.forEach((f, i) => {
    const owner = f[2]!;
    if (owner < 0) return;
    const team = owner < nHome ? 0 : 1;
    if (team !== current) {
      possessions += 1;
      current = team;
      inZone = false;
    }
    held += 1;
    const homeDir = i * rp.sample_ticks < C.TICKS_PER_HALF ? 1 : -1;
    const gx = (team === 0 ? homeDir : -homeDir) > 0 ? rp.pitch[0] : 0.0;
    const near = hypot(gx - f[0]! / k, rp.pitch[1] / 2 - f[1]! / k) < C.SHOOT_RANGE_M;
    if (near && !inZone) entries += 1;
    inZone = near;
  });
  return [possessions, entries, held];
}

// --------------------------------------------------------------- 陣形の広がり
//
// 🔴 2026-10-04 オーナー指摘「ボールを追って団子になる」「真ん中しか使えていなくてサイドが全く使えていない。
//    エリアが広く使えてなくて、凄く単調なゲームに見える」。
//    実測で、攻める側の幅 27.9m（現実は 43〜48m）、敵陣3分の1での保持が中央 86%・左右 7% ずつだった。
//    得点・シュート・決定率がすべて相場の内側でも起きていた＝平均のスタッツでは見えないので、専用に数える。
//
// 出典:
//   [PLOS] Extracting spatial-temporal features that describe a team match demands when considering the
//          effects of the quality of opposition in elite football（PLOS ONE 2019）— 保持しているチームの
//          幅 42.74±5.8m〜47.75±6.04m、縦 36.70±4.52m〜38.42±4.36m（外側のフィールド選手どうしの差）
//          https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0221368
//   [OPTA] The Analyst「Mapped Out: Where Every Premier League Team Creates Chances From」2025-26 —
//          決定機を作った場所 中央3分の1 27.9 / 左 25.6 / 右 22.5（＝左右で約64%）
//          https://theanalyst.com/articles/premier-league-stats-attacking-thirds-2025-26
export const SHAPE_EXPECTED: Readonly<Record<string, Expected>> = {
  width_attack: { low: 37.0, high: 54.0,
                  source: "[PLOS] 保持しているチームの幅 42.7〜47.8m（±1標準偏差で 37〜54m）" },
  length_attack: { low: 32.0, high: 44.0,
                   source: "[PLOS] 保持しているチームの縦 36.7〜38.4m（±1標準偏差で 32〜43m）" },
};
// 敵陣3分の1で、ボールが左右の3分の1にあった割合の床（監視＋掃き出しの床。保持の場所と決定機の場所は別の数なので判定には使わない）
export const WIDE_SHARE_FLOOR = 0.40;
export const SHAPE_LABELS: Readonly<Record<string, string>> = {
  width_attack: "攻撃時の幅m", length_attack: "攻撃時の縦m",
};

/** [攻める側の幅の合計, 縦の合計, 守る側の幅の合計, ボールの10m以内の人数の合計, コマ数, 敵陣3分の1の左, 中, 右]。 */
export function shapeCounts(result: MatchResult): number[] {
  const rp = result.replay;
  if (rp === undefined) throw new Error("record=true で回した試合を渡すこと");
  const k = rp.coord_scale;
  const nHome = rp.roster.filter((r) => r.team === 0).length;
  const out = new Array<number>(8).fill(0);
  rp.frames.forEach((f, i) => {
    const owner = f[2]!;
    if (owner < 0) return;
    const team = owner < nHome ? 0 : 1;
    const xs: number[][] = [[], []];
    const ys: number[][] = [[], []];
    let crowd = 0;
    const bx = f[0]! / k;
    const by = f[1]! / k;
    rp.roster.forEach((r, p) => {
      if (r.pos === "GK") return;
      const x = f[3 + p * 2]! / k;
      const y = f[4 + p * 2]! / k;
      xs[r.team]!.push(x);
      ys[r.team]!.push(y);
      if (hypot(x - bx, y - by) <= 10.0) crowd += 1;
    });
    const span = (v: number[]): number => Math.max(...v) - Math.min(...v);
    out[0]! += span(ys[team]!);
    out[1]! += span(xs[team]!);
    out[2]! += span(ys[1 - team]!);
    out[3]! += crowd;
    out[4]! += 1;
    const homeDir = i * rp.sample_ticks < C.TICKS_PER_HALF ? 1 : -1;
    const ax = (team === 0 ? homeDir : -homeDir) > 0 ? bx : rp.pitch[0] - bx;
    if (ax > rp.pitch[0] * 2 / 3) {
      const third = rp.pitch[1] / 3;
      out[by < third ? 5 : by < 2 * third ? 6 : 7]! += 1;
    }
  });
  return out;
}

/** 集計から [攻撃時の幅, 縦, 守備時の幅, 10m以内の人数, 左右の割合]。 */
export function shapeSummary(c: readonly number[]): { width_attack: number; length_attack: number;
    width_defend: number; crowd: number; wide_share: number } {
  const n = Math.max(1, c[4]!);
  const third = c[5]! + c[6]! + c[7]!;
  return { width_attack: c[0]! / n, length_attack: c[1]! / n, width_defend: c[2]! / n,
           crowd: c[3]! / n, wide_share: (c[5]! + c[7]!) / Math.max(1, third) };
}

// --------------------------------------------------------------- 出した人が止まらないか（D-46）
//
// 🔴 2026-10-05 オーナー指摘「パスという行動をした直後に選手が硬直してる。本来パスした後は
//    味方にボールが渡った渡ってないに限らず、オフザボールの動きになるべき」。
//    実測で、パスを出した秒の移動が 0.00m（100%）だった。運んでいる間は 2.4m/秒。
//    相場ではなく**要件**（出したら動く）なので、出典ではなくオーナーの言葉を根拠に判定する。
/** 出した秒にほぼ動かなかった（この距離未満）とみなす線 m */
export const RELEASE_STILL_M = 0.3;
/** 出した秒にほぼ動かなかったパスの割合の上限（判定する）。直す前は 100%・直した後は約 11% */
export const RELEASE_STILL_MAX = 0.25;

/**
 * コマを秒として読む道具のための確認。**1秒に1コマ**で記録した試合だけを受け付ける（D-49: 刻みは秒ではない）。
 */
export function needPerSecond(rp: { sample_ticks: number; tick_s: number }): void {
  if (rp.sample_ticks * rp.tick_s !== 1) {
    throw new Error(`1秒に1コマで記録した試合を渡すこと（${rp.sample_ticks}刻み×${rp.tick_s}秒）`);
  }
}

/** 刻み `tick` に起きた出来事の、**その秒の始めのコマ**の番号（1秒刻みなら tick−1） */
export function frameBefore(rp: { sample_ticks: number }, tick: number): number {
  return Math.floor((tick - 1) / rp.sample_ticks);
}

/** [パスと外れたシュートの数, 蹴った秒に動いた距離の合計, 出した秒にほぼ動かなかった数, 出した後3秒の移動の合計]。 */
export function releaseCounts(result: MatchResult): number[] {
  const rp = result.replay;
  if (rp === undefined) throw new Error("record=true で回した試合を渡すこと");
  // 🔴 コマの番号＝秒として読む。間引いて記録した試合では1秒ぶんの移動が取れない
  needPerSecond(rp);
  const k = rp.coord_scale;
  const at = (t: number, p: number): [number, number] =>
    [rp.frames[t]![3 + p * 2]! / k, rp.frames[t]![4 + p * 2]! / k];
  const moved = (t0: number, t1: number, p: number): number => {
    const [x0, y0] = at(t0, p);
    const [x1, y1] = at(t1, p);
    return hypot(x1 - x0, y1 - y0);
  };
  const out = [0, 0, 0, 0];
  for (const e of result.events) {
    // 🔑 外れた・止められたシュートも同じ（入ったときは笛が鳴って喜ぶので数えない）
    if ((e.type !== "パス" && e.type !== "シュート") || e.player === null) continue;
    const t = frameBefore(rp, e.tick) + 1;   // 蹴った秒の終わりのコマ
    if (t < 1 || t + 3 >= rp.frames.length) continue;
    // 🔑 出した人＝出来事に付いたコマの番号（D-49。1秒に何度も持ち主が変わるので、秒の始めの持ち主では当てられない）
    const p = e.slot ?? -1;
    const team = e.team === result.teams[0] ? 0 : 1;
    if (p < 0 || rp.roster[p]!.team !== team) throw new Error(`${e.time} の${e.type}の直前に、蹴ったチームの持ち主がいない`);
    const d = moved(t - 1, t, p);           // 出した秒（コマ t-1 → t）
    out[0]! += 1;
    out[1]! += d;
    if (d < RELEASE_STILL_M) out[2]! += 1;
    out[3]! += moved(t, t + 3, p);
  }
  return out;
}

// --------------------------------------------------------------- 疲れ方（出典つき・判定する）
//
// 🔴 2026-10-05 実測: 後半の走行が前半より 27% 少なく、最後の15分は高強度の走りが**ゼロ**だった。
//    体力が 4.5km ほどで空になり、後半は全員が速度の床で歩いていた（息切れ 1チーム13〜14人）。
//    走る意思（裏へ走る・顔を出す）にも体力の倍率がかかるので、裏抜けが全体の 0.7% まで消えていた。
//
// 出典:
//   [BRAD] Bradley et al. (2009) High-intensity running in English FA Premier League soccer matches
//          — 走行 前半 5,422m / 後半 5,292m（−2.4%）
//          https://www.researchgate.net/publication/23801521_High-intensity_running_in_English_FA_Premier_League_Soccer_Matches
//   [MOHR] Mohr, Krustrup & Bangsbo (2003) Match performance of high-standard soccer players with special
//          reference to development of fatigue（J Sports Sci 21:519-528）— 最後の15分の高強度の走り（15km/h 以上）は最初の15分より 20〜45% 少ない
//          https://www.semanticscholar.org/paper/Match-performance-of-high-standard-soccer-players-Mohr-Krustrup/d6e9d14213e3c5f0946bdbfd42251f9e7c90d4ea
export const FATIGUE_EXPECTED: Readonly<Record<string, Expected>> = {
  second_half_pct: { low: -10.0, high: 0.0,
                     source: "[BRAD] 後半の走行は前半の −2.4%（ポジション・試合で幅があるので −10〜0%）" },
  hi_last15_pct: { low: -50.0, high: -15.0,
                   source: "[MOHR] 最後の15分の高強度（15km/h 以上）は最初の15分の −20〜−45%（幅を見て −50〜−15%）" },
};
export const FATIGUE_LABELS: Readonly<Record<string, string>> = {
  second_half_pct: "後半の走行%", hi_last15_pct: "終盤の高強度%",
};
/** 高強度の走りの線（m/秒）。**相場の出典 [MOHR] と同じ定義** 15km/h（19.8km/h は別の研究の線なので混ぜない） */
export const HIGH_INTENSITY_MPS = 15.0 / 3.6;
/** 1秒にこれより動いたら走った距離ではなく配置の入れ替え（後半開始・交代）として数えない m */
export const REPOSITION_M = C.SPEED_MAX_MPS * 1.5;

/** [前半の走行, 後半の走行, 最初15分の高強度, 最後15分の高強度]（GKを除くフィールド選手の合計 m）。 */
export function fatigueCounts(result: MatchResult): number[] {
  const rp = result.replay;
  if (rp === undefined) throw new Error("record=true で回した試合を渡すこと");
  needPerSecond(rp);
  const k = rp.coord_scale;
  const F = rp.frames;
  const quarter = C.TICKS_PER_MATCH / 6;          // 15分
  const out = [0, 0, 0, 0];
  for (let t = 1; t < F.length; t++) {
    rp.roster.forEach((r, p) => {
      if (r.pos === "GK") return;
      const d = hypot(F[t]![3 + p * 2]! / k - F[t - 1]![3 + p * 2]! / k,
                      F[t]![4 + p * 2]! / k - F[t - 1]![4 + p * 2]! / k);
      if (d > REPOSITION_M) return;               // 後半開始の並び直し・交代（走ったのではない）
      const tick = t * rp.sample_ticks;
      out[tick < C.TICKS_PER_HALF ? 0 : 1]! += d;
      if (d >= HIGH_INTENSITY_MPS) {
        if (tick < quarter) out[2]! += d;
        else if (tick >= C.TICKS_PER_MATCH - quarter) out[3]! += d;
      }
    });
  }
  return out;
}

/** 集計から [後半の走行の増減%, 最後15分の高強度の増減%]。 */
export function fatigueSummary(c: readonly number[]): { second_half_pct: number; hi_last15_pct: number } {
  return { second_half_pct: 100 * (c[1]! / Math.max(1, c[0]!) - 1),
           hi_last15_pct: 100 * (c[3]! / Math.max(1, c[2]!) - 1) };
}

// --------------------------------------------------------------- どこから撃ったか（出典つき・判定する）
//
// 🔴 2026-10-05 実測: ペナルティエリアの外からのシュートが**0本**。撃つ基準（`SHOT_MIN_XG`）が、
//    遠目の入る確率（2〜4%・現実の 4.2% と合っている）より高く、遠目のシュートが**作りとして不可能**だった。
//
// 出典:
//   [OPTA-SHOT] The Analyst「Finding Their Range: Where Premier League Teams Are Shooting From in 2024-25」—
//          エリアの外からのシュートは全体の 31.7%（記録が残る 2003-04 以降で最も少ない）。
//          エリアの外の決定率 4.2%／中 14.7%
//          https://theanalyst.com/articles/premier-league-2024-25-shot-data
export const SHOT_PLACE_EXPECTED: Readonly<Record<string, Expected>> = {
  outside_box_pct: { low: 20.0, high: 45.0,
                     source: "[OPTA-SHOT] エリアの外から 31.7%（史上最少の季節。以前はもっと多い）" },
};
// 🟡 **既知の赤**（2026-10-05）。撃つ基準を下げて 0% → 12% まで来たが、相場（31.7%）に届かない。
//    蹴る力で基準を下げる・撃ちたくなる倍率は、どちらも割合を動かさなかったので入れていない（決定記録 D-47）。
//    相場に戻ったら false にすること（戻ったのに true のままだと止める）
export const SHOT_PLACE_KNOWN_RED = true;
export const SHOT_PLACE_LABELS: Readonly<Record<string, string>> = { outside_box_pct: "エリア外から%" };
/** ペナルティエリアの奥行き・幅（m）。競技規則 */
export const BOX_DEPTH_M = 16.5;
export const BOX_WIDTH_M = 40.32;

/** [シュート（ゴールを含む）, そのうちエリアの外, エリアの外のゴール]。 */
export function shotPlaceCounts(result: MatchResult): number[] {
  const rp = result.replay;
  if (rp === undefined) throw new Error("record=true で回した試合を渡すこと");
  needPerSecond(rp);
  const k = rp.coord_scale;
  const out = [0, 0, 0];
  for (const e of result.events) {
    if (e.type !== "シュート" && e.type !== "ゴール") continue;
    const t = frameBefore(rp, e.tick) + 1;
    if (t < 1) throw new Error(`${e.time} の${e.type}が試合の最初の秒にある（直前の持ち主を引けない）`);
    // 🔑 撃った人＝出来事に付いたコマの番号。場所はその秒の始めのコマ（撃つまでに1秒ぶん動きうる・D-49）
    const p = e.slot ?? -1;
    const team = e.team === result.teams[0] ? 0 : 1;
    if (p < 0 || rp.roster[p]!.team !== team) throw new Error(`${e.time} の${e.type}の直前に、撃ったチームの持ち主がいない`);
    const x = rp.frames[t - 1]![3 + p * 2]! / k;
    const y = rp.frames[t - 1]![4 + p * 2]! / k;
    const homeDir = e.tick < C.TICKS_PER_HALF ? 1 : -1;
    const toward = team === 0 ? homeDir : -homeDir;      // +1 なら x=PITCH_X のゴールを攻める
    const depth = toward > 0 ? rp.pitch[0] - x : x;
    const outside = depth > BOX_DEPTH_M || Math.abs(y - rp.pitch[1] / 2) > BOX_WIDTH_M / 2;
    out[0]! += 1;
    if (outside) {
      out[1]! += 1;
      if (e.type === "ゴール") out[2]! += 1;
    }
  }
  return out;
}

/** プリセット総当たりを走らせ、チームごとの平均値を返す（3つ目は攻撃の到達点の帯ごとの数、4つ目は [空いた場面, 撃てた]）。 */
export function measure(reps: number): [Rows, number, number[], number[], number[], number[], number[], number[], number[]] {
  const names = [...PRESET_ORDER];
  const teams = new Map(names.map((n) => [n, buildPreset(n)]));
  const agg: Record<string, Record<string, number[]>> = {};
  for (const n of names) agg[n] = Object.fromEntries(RAW_KEYS.map((k) => [k, [] as number[]]));
  let nMatches = 0;
  const reach = REACH_BANDS.map(() => 0);
  const openGoal = new Array<number>(OPEN_GOAL_BANDS.length * 4).fill(0);
  const funnel = [0, 0, 0, 0];   // 攻撃の回数, 侵入, 保持コマ, シュート
  const shape = new Array<number>(8).fill(0);
  const release = [0, 0, 0, 0];
  const fatigue = [0, 0, 0, 0];
  const shotPlace = [0, 0, 0];
  // 勝ち点の割合（勝ち1・引き分け0.5）。相性 [7] と同じ数え方の粗い版（監視のみ）
  const wins: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, [] as number[]]));

  for (const [home, away] of combinations(names)) {
    for (let off = 0; off < reps; off++) {
      const result = play(teams.get(home)!.clone(), teams.get(away)!.clone(), 1000 + off, true,
                          true);
      nMatches += 1;
      reachCounts(result).forEach((c, i) => { reach[i]! += c; });
      openGoalCounts(result).forEach((c, i) => { openGoal[i]! += c; });
      funnelCounts(result).forEach((c, i) => { funnel[i]! += c; });
      funnel[3]! += result.stats[0]!.shots + result.stats[1]!.shots;
      shapeCounts(result).forEach((c, i) => { shape[i]! += c; });
      releaseCounts(result).forEach((c, i) => { release[i]! += c; });
      fatigueCounts(result).forEach((c, i) => { fatigue[i]! += c; });
      shotPlaceCounts(result).forEach((c, i) => { shotPlace[i]! += c; });
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
    row.takeon_success_pct = 100.0 * sum(s.takeons_won!) / Math.max(1.0, sum(s.takeons!));
    row.win_pct = 100.0 * mean(wins[n]!);
    out[n] = row;
  }
  return [out, nMatches, reach, openGoal, funnel, shape, release, fatigue, shotPlace];
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
  const [rows, nMatches, reach, openGoal, funnel, shape, release, fatigue, shotPlace] = measure(reps);
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

  out(`
--- 空いたゴールへ撃てたか（前にGKしかいない場面・帯ごと・監視のみ） ---`);
  OPEN_GOAL_BANDS.forEach(([, , label], b) => {
    const [n, hit, alone, aloneHit] = openGoal.slice(b * 4, b * 4 + 4) as [number, number, number, number];
    out(`  ${ljust(label, 12)} 空いた ${rjust(String(n), 5)}回 → 撃てた ${rjust(fmtF(100 * hit / Math.max(1, n), 0), 3)}%`
        + `   完全に空いた ${rjust(String(alone), 5)}回 → 撃てた ${rjust(fmtF(100 * aloneHit / Math.max(1, alone), 0), 3)}%`);
  });

  const teamMatches = Math.max(1, nMatches * 2);
  out("\n--- 攻撃の流れ（1チーム1試合・監視のみ） ---");
  out(`  攻撃の回数 ${fmtF(funnel[0]! / teamMatches, 1)}（1回 ${fmtF(funnel[2]! / Math.max(1, funnel[0]!), 1)}秒）`
      + `  24m以内への侵入 ${fmtF(funnel[1]! / teamMatches, 1)}`
      + `  侵入あたりシュート ${fmtF(funnel[3]! / Math.max(1, funnel[1]!), 2)}`);

  const sh = shapeSummary(shape);
  out("\n--- 陣形の広がり（出典つき・判定する） ---");
  for (const [key, e] of Object.entries(SHAPE_EXPECTED)) {
    const v = sh[key as keyof typeof sh];
    out(`  ${holds(e, v) ? "✅" : "🔴"} ${ljust(SHAPE_LABELS[key]!, 10)} ${rjust(fmtF(v, 1), 6)}  相場 ${pyFloatStr(e.low)}〜${pyFloatStr(e.high)}`);
    out(`       出典: ${e.source}`);
  }
  out(`  （監視）守備時の幅 ${fmtF(sh.width_defend, 1)}m ／ ボールの10m以内 ${fmtF(sh.crowd, 1)}人 ／ 敵陣3分の1でサイドにあった割合 ${fmtF(100 * sh.wide_share, 0)}%`);

  const passes = Math.max(1, release[0]!);
  const stillShare = release[2]! / passes;
  out("\n--- 出した人が止まらないか（要件・判定する） ---");
  out(`  ${stillShare <= RELEASE_STILL_MAX ? "✅" : "🔴"} 出した秒にほぼ動かなかった ${fmtF(100 * stillShare, 0)}%（上限 ${fmtF(100 * RELEASE_STILL_MAX, 0)}%）`
      + `  出した秒の移動 ${fmtF(release[1]! / passes, 2)}m  その後3秒 ${fmtF(release[3]! / passes, 1)}m`);

  const fa = fatigueSummary(fatigue);
  out("\n--- 疲れ方（出典つき・判定する） ---");
  for (const [key, e] of Object.entries(FATIGUE_EXPECTED)) {
    const v = fa[key as keyof typeof fa];
    out(`  ${holds(e, v) ? "✅" : "🔴"} ${ljust(FATIGUE_LABELS[key]!, 10)} ${rjust(fmtF(v, 1), 6)}  相場 ${pyFloatStr(e.low)}〜${pyFloatStr(e.high)}`);
    out(`       出典: ${e.source}`);
  }

  const outsidePct = 100 * shotPlace[1]! / Math.max(1, shotPlace[0]!);
  const spE = SHOT_PLACE_EXPECTED.outside_box_pct!;
  out(`${String.fromCharCode(10)}--- どこから撃ったか（出典つき・判定する） ---`);
  out(`  ${holds(spE, outsidePct) ? "✅" : SHOT_PLACE_KNOWN_RED ? "🟡" : "🔴"} ${ljust(SHOT_PLACE_LABELS.outside_box_pct!, 10)} ${rjust(fmtF(outsidePct, 1), 6)}  相場 ${pyFloatStr(spE.low)}〜${pyFloatStr(spE.high)}`
      + `  （エリアの外の決定率 ${fmtF(100 * shotPlace[2]! / Math.max(1, shotPlace[1]!), 1)}%・出典では 4.2%）`);
  out(`       出典: ${spE.source}`);

  const [blocking, stillRed] = judge(rows);
  const placeItem = `${SHOT_PLACE_LABELS.outside_box_pct} ${fmtF(outsidePct, 1)}（相場 ${pyFloatStr(spE.low)}〜${pyFloatStr(spE.high)}）`;
  if (!holds(spE, outsidePct)) (SHOT_PLACE_KNOWN_RED ? stillRed : blocking).push(SHOT_PLACE_KNOWN_RED ? placeItem : `（撃つ場所が相場の外）${placeItem}`);
  else if (SHOT_PLACE_KNOWN_RED) blocking.push(`（相場に戻った）${placeItem}: SHOT_PLACE_KNOWN_RED を false にすること`);
  for (const [key, e] of Object.entries(FATIGUE_EXPECTED)) {
    const v = fa[key as keyof typeof fa];
    if (!holds(e, v)) blocking.push(`（疲れ方が相場の外）${FATIGUE_LABELS[key]} ${fmtF(v, 1)}（相場 ${pyFloatStr(e.low)}〜${pyFloatStr(e.high)}）`);
  }
  if (stillShare > RELEASE_STILL_MAX) blocking.push(`（出した人が固まる）出した秒にほぼ動かなかった ${fmtF(100 * stillShare, 0)}%（上限 ${fmtF(100 * RELEASE_STILL_MAX, 0)}%）`);
  for (const [key, e] of Object.entries(SHAPE_EXPECTED)) {
    const v = sh[key as keyof typeof sh];
    if (!holds(e, v)) blocking.push(`（陣形が相場の外）${SHAPE_LABELS[key]} ${fmtF(v, 1)}（相場 ${pyFloatStr(e.low)}〜${pyFloatStr(e.high)}）`);
  }
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
