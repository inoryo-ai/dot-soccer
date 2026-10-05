/**
 * 試合データから「ボールの位置の価値（xT: Expected Threat）」の表を作る（D-42・2026-10-05 オーナー判断）。
 *
 * 使い方（データは大きいのでリポジトリに入れない。figshare から取って展開した場所を渡す）:
 *     node --max-old-space-size=6144 scripts/build_xt.ts <events_*.json のあるフォルダ>
 *   → src/sim/match/xt_grid.ts を書き出す
 *
 * データ: Wyscout 公開データ（Pappalardo ら 2019, Scientific Data。figshare c.4415000・events.zip）。
 *   **CC BY 4.0**（出典を書けば商用で使える）。欧州5大リーグ 2017/18・W杯2018・EURO2016。
 *
 * 作り方（Karun Singh 2019 "Introducing Expected Threat" の方法）:
 *   ピッチを 16×12 のマスに分け、マスごとに
 *     s ＝ そこでシュートした割合、m ＝ パスやドリブルで動かした割合（s ＋ m ＝ 1）
 *     g ＝ そこからのシュートが入った割合
 *     T ＝ そこから動かして、成功して別のマスへ届いた割合（行き先ごと。失敗は行き先に数えない）
 *   を数え、xT(マス) ＝ s × g ＋ m × Σ T(行き先) × xT(行き先) を、変化が無くなるまで繰り返す。
 *   セットプレー（フリーキック・CK・PK・スローイン・ゴールキック）は数えない（流れの中の価値にするため）。
 *
 * 🔑 座標は攻める向きが x = 0→100、y = 0→100 の割合。ゲームでは 105×68m に当てはめる。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "sim", "match", "xt_grid.ts");
const NX = 16;
const NY = 12;

interface WyEvent {
  eventId: number;
  subEventId: number | "";
  tags: { id: number }[];
  positions: { x: number; y: number }[];
  matchId: number;
}

const cell = (p: { x: number; y: number }): number => {
  const xi = Math.min(NX - 1, Math.max(0, Math.floor(p.x / 100 * NX)));
  const yi = Math.min(NY - 1, Math.max(0, Math.floor(p.y / 100 * NY)));
  return xi * NY + yi;
};

function main(argv: string[]): number {
  const dir = argv[0];
  if (dir === undefined) {
    console.error("使い方: node --max-old-space-size=6144 scripts/build_xt.ts <events_*.json のあるフォルダ>");
    return 2;
  }
  const N = NX * NY;
  const shots = new Float64Array(N);
  const goals = new Float64Array(N);
  const moves = new Float64Array(N);
  const trans = new Float64Array(N * N);
  const matches = new Set<number>();
  let used = 0;
  const files = readdirSync(dir).filter((f) => f.startsWith("events_") && f.endsWith(".json")).sort();
  for (const f of files) {
    const events = JSON.parse(readFileSync(join(dir, f), "utf8")) as WyEvent[];
    for (const e of events) {
      const start = e.positions[0];
      if (start === undefined) continue;
      const tags = new Set(e.tags.map((t) => t.id));
      if (e.eventId === 10) {                                   // シュート（流れの中）
        const c = cell(start);
        shots[c]! += 1;
        if (tags.has(101)) goals[c]! += 1;                     // 101 = ゴール
        used += 1;
        matches.add(e.matchId);
      } else if (e.eventId === 8 || (e.eventId === 7 && e.subEventId === 70)) {   // パス・ドリブル（Acceleration）
        const c = cell(start);
        moves[c]! += 1;
        const end = e.positions[1];
        if (tags.has(1801) && end !== undefined) trans[c * N + cell(end)]! += 1;   // 1801 = 成功
        used += 1;
        matches.add(e.matchId);
      }
    }
    console.log(`${f}: ${events.length} 件を読んだ`);
  }

  // 繰り返して xT を求める
  let xt = new Float64Array(N);
  for (let it = 0; it < 200; it++) {
    const next = new Float64Array(N);
    let change = 0.0;
    for (let c = 0; c < N; c++) {
      const total = shots[c]! + moves[c]!;
      if (total === 0) continue;
      const s = shots[c]! / total;
      const m = moves[c]! / total;
      const g = shots[c]! > 0 ? goals[c]! / shots[c]! : 0.0;
      let ev = 0.0;
      if (moves[c]! > 0) {
        for (let d = 0; d < N; d++) {
          const n = trans[c * N + d]!;
          if (n > 0) ev += n / moves[c]! * xt[d]!;
        }
      }
      next[c] = s * g + m * ev;
      change = Math.max(change, Math.abs(next[c]! - xt[c]!));
    }
    xt = next;
    if (change < 1e-7) {
      console.log(`${it + 1} 回で収束`);
      break;
    }
  }

  const rows: string[] = [];
  for (let xi = 0; xi < NX; xi++) {
    const row: string[] = [];
    for (let yi = 0; yi < NY; yi++) row.push(xt[xi * NY + yi]!.toFixed(6));
    rows.push(`  [${row.join(", ")}],`);
  }
  const body = `/**
 * ボールの位置の価値（xT: Expected Threat）の表。**scripts/build_xt.ts が書き出したもの。手で直さない。**
 *
 * データ: Wyscout 公開データ（Pappalardo, L. ら 2019, "A public data set of spatio-temporal match events in
 *   soccer competitions", Scientific Data 6:236。figshare c.4415000）。ライセンス CC BY 4.0。
 *   欧州5大リーグ 2017/18・W杯2018・EURO2016 の ${matches.size} 試合、パス・ドリブル・シュート ${used} 件。
 * 方法: Karun Singh (2019) "Introducing Expected Threat (xT)"。セットプレーは除く。
 *
 * 並び: XT_GRID[x の番号][y の番号]。x は攻める向き（0＝自陣ゴール側 → ${NX - 1}＝相手ゴール側）を ${NX} 等分、
 *   y はピッチの幅を ${NY} 等分。値は「そこでボールを持っているとき、この先そのチームが点を取る見込み」。
 */

export const XT_NX = ${NX};
export const XT_NY = ${NY};

export const XT_GRID: readonly (readonly number[])[] = [
${rows.join("\n")}
];
`;
  writeFileSync(OUT, body, "utf8");
  let max = 0;
  for (const v of xt) max = Math.max(max, v);
  console.log(`${matches.size} 試合・${used} 件 → ${OUT}（最大値 ${max.toFixed(4)}）`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
