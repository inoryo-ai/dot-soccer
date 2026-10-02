/**
 * 公開・提出の前に機械で止める検査。
 *
 * 学習台帳（`ino_company/docs/loop-learnings.md`）の昇格ルールに従い、
 * このループで**実際に踏んだ失敗**を人の注意力に頼らず止める形にしている。
 *
 *     node scripts/check_project.ts      （npm run check）
 *
 * 各検査は「どこから何件読んだか」を必ず出す（件数の無い検査は、
 * その検査が空振りしていないことを誰も確認できない）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import * as C from "../src/sim/constants.ts";
import { SAVE_VERSION } from "../src/sim/career.ts";
import { combinations } from "../src/sim/batch.ts";
import { LEAGUE_OPPONENTS, PRESET_ORDER, buildPreset, checkNoClamping,
         expectedAbilityTotal } from "../src/sim/presets.ts";
import { fmtPct } from "../src/sim/pymath.ts";
import { CARD_KEYS, FORBIDDEN_PAIRS, SPECIAL_NAMES, pairKey } from "../src/sim/training.ts";
import { loadTeam } from "../src/node/files.ts";
import { runBatch } from "../src/node/batch_pool.ts";
import { DIST, build, listFiles } from "./build_web.ts";
import { KNOWN_RED } from "./measure.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

const DUMMY_MARKERS = ["TODO", "FIXME", "XXX", "あとで直す", "仮の値", "ダミー", "0120-XXX"];

const failures: string[] = [];
const ok = (msg: string): void => console.log(`  ✅ ${msg}`);
const bad = (msg: string): void => {
  failures.push(msg);
  console.log(`  ❌ ${msg}`);
};

function tsFiles(dir: string): string[] {
  return listFiles(dir).filter((f) => f.endsWith(".ts"));
}

/** 未確定値・書き置きを残したまま提出しない（台帳: 黒瀬[2回]・機械化済み項目の移植）。 */
function checkDummyValues(): void {
  // この検査自身は対象外（探す語そのものを持っているため、必ず自分に当たる）
  const files = [...tsFiles(join(ROOT, "src")), ...tsFiles(join(ROOT, "scripts"))]
    .filter((f) => f !== SELF);
  console.log(`[1] ダミー値・書き置きの検査 — ${join(ROOT, "src")} と ${join(ROOT, "scripts")}`
              + ` から ${files.length}ファイル`);
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      for (const marker of DUMMY_MARKERS) {
        if (line.includes(marker)) hits.push(`${relative(ROOT, f)}:${i + 1} ${marker}`);
      }
    });
  }
  if (hits.length > 0) for (const h of hits) bad(`未確定値が残っている: ${h}`);
  else ok(`${files.length}ファイルに未確定値なし`);
}

/** 定数どうしの関係が壊れていないか。どれも実際に踏んで初めて分かった条件。 */
function checkConstantsInvariants(): void {
  console.log("[2] 定数の不変条件 — src/sim/constants.ts から 5項目");
  if (C.PRESS_STANDOFF_M > C.TACKLE_RADIUS_M) {
    ok(`寄せの間合い ${C.PRESS_STANDOFF_M}m > 奪い合いの距離 ${C.TACKLE_RADIUS_M}m`);
  } else {
    bad(`寄せの間合い ${C.PRESS_STANDOFF_M}m が奪い合いの距離 ${C.TACKLE_RADIUS_M}m の内側`
        + "（全員が毎秒奪い合いに参加する。実測で1試合4,081回になった）");
  }
  if (C.TICKS_PER_MATCH === C.TICKS_PER_HALF * 2 && C.TICKS_PER_MATCH === 5400) {
    ok("90分 = 5400ティック（前後半 2700 ずつ）");
  } else {
    bad(`試合の長さが 5400 ティックでない: ${C.TICKS_PER_MATCH}`);
  }
  if (C.TYPE_THRESHOLD > 0 && C.TYPE_THRESHOLD <= C.HIDDEN_MAX) {
    ok(`タイプ判定の閾値 ${C.TYPE_THRESHOLD} が範囲内`);
  } else {
    bad(`タイプ判定の閾値が異常: ${C.TYPE_THRESHOLD}`);
  }
  if (C.BATCH_WIN_RATE_WARN_LOW < 0.5 && 0.5 < C.BATCH_WIN_RATE_WARN_HIGH) {
    ok(`勝率警告は床 ${fmtPct(C.BATCH_WIN_RATE_WARN_LOW, 0)} と天井 `
       + `${fmtPct(C.BATCH_WIN_RATE_WARN_HIGH, 0)} の両方を見ている`);
  } else {
    bad("勝率警告が片側しか見ていない（弱すぎるチームを見逃す）");
  }
  if (C.ACTION_CONTROL_TICKS >= 1 && C.TACKLE_COOLDOWN_TICKS >= 1) {
    ok("1回の行動に秒数が設定されている");
  } else {
    bad("行動が毎ティック起きる設定になっている（スタッツが現実離れする）");
  }
}

/** data/ の実物を読む。タイプ（導出値）が書かれていたら落とす（D-07）。 */
function checkDataFiles(): void {
  const dir = join(ROOT, "data");
  const paths = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f))
    : [];
  console.log(`[3] チームJSONの検査 — ${dir} から ${paths.length}ファイル`);
  if (paths.length === 0) {
    bad("data/ にチームJSONが1件も無い（`npm run sim -- presets` を実行する）");
    return;
  }
  let players = 0;
  for (const p of paths) {
    const name = p.split("/").pop();
    const raw = JSON.parse(readFileSync(p, "utf8")) as { players: Record<string, unknown>[];
                                                          bench?: Record<string, unknown>[] };
    for (const entry of [...raw.players, ...(raw.bench ?? [])]) {
      players += 1;
      if ("type" in entry) bad(`${name}: 選手 ${String(entry.name)} にタイプが保存されている（D-07違反）`);
    }
    try {
      const team = loadTeam(p);
      if (team.players.length !== C.PLAYERS_ON_PITCH) bad(`${name}: 先発が ${team.players.length}人`);
    } catch (e) {
      bad(`${name}: 読み込めない: ${(e as Error).message}`);
    }
  }
  ok(`${paths.length}ファイル・${players}選手を実際に読んで検査した`);
}

function checkSpecialNames(): void {
  const allPairs = combinations(CARD_KEYS).map(([a, b]) => pairKey(a, b));
  console.log(`[4] スペシャル名の検査 — カード${CARD_KEYS.length}枚の組み合わせ ${allPairs.length}種`);
  const missing = allPairs.filter((p) => !SPECIAL_NAMES.has(p) && !FORBIDDEN_PAIRS.has(p));
  const extra = [...SPECIAL_NAMES.keys()].filter((p) => FORBIDDEN_PAIRS.has(p));
  if (missing.length > 0) bad(`名前の無い組み合わせ: ${JSON.stringify(missing)}`);
  if (extra.length > 0) bad(`相反する組に名前が付いている: ${JSON.stringify(extra)}`);
  const names = [...SPECIAL_NAMES.values()];
  if (names.length !== new Set(names).size) bad("スペシャル名が重複している");
  if (missing.length === 0 && extra.length === 0 && names.length === new Set(names).size) {
    ok(`${names.length}種に固有の名前があり、相反${FORBIDDEN_PAIRS.size}組は名前なし`);
  }
}

function checkPresets(): void {
  console.log("[5] プリセットの能力合計 — 6チーム");
  const problems = checkNoClamping();
  if (problems.length > 0) for (const p of problems) bad(p);
  else ok("6チームの能力合計が一致（特訓が上限で切られていない）");
}

/** リーグが組めるか。奇数チームだと必ず1チームが休みになり消化試合数が揃わない。 */
function checkLeagueSetup(): void {
  const n = LEAGUE_OPPONENTS.length + 1;                    // ＋自チーム
  console.log(`[6] リーグ編成 — 自チーム＋AI ${LEAGUE_OPPONENTS.length}チーム = ${n}チーム`);
  if (n % 2 === 0) ok(`${n}チーム（偶数）＝全チームが同じ試合数を消化できる`);
  else bad(`${n}チーム（奇数）＝日程が組めない`);
  if (PRESET_ORDER.every((name, i) => LEAGUE_OPPONENTS[i] === name)) {
    ok(`batch の勝率表は要件どおり ${PRESET_ORDER.length}チームのまま`
       + "（リーグ用の追加に引きずられていない）");
  } else {
    bad("batch のプリセット構成が変わっている（提出済みの勝率表と前提がずれる）");
  }
  const expected = expectedAbilityTotal();
  const off = LEAGUE_OPPONENTS.filter((name) => buildPreset(name).abilityTotal() !== expected);
  if (off.length > 0) bad(`能力合計が揃っていないAIチーム: ${JSON.stringify(off)}`);
  else ok(`AI ${LEAGUE_OPPONENTS.length}チームの能力合計が ${expected} で一致`);
  if (Number.isInteger(SAVE_VERSION) && SAVE_VERSION >= 1) ok(`セーブ形式 v${SAVE_VERSION}`);
  else bad(`セーブ形式の版が異常: ${SAVE_VERSION}`);
}

/**
 * 要件定義書が挙げているファイル・定数が実在するか。
 *
 * 🔴 台帳「ドキュメントの『実装済み』表は自己申告。機械で検証できる形にする」。
 *    §13 の対応表は、書いた時点では正しくても**コードを動かすと黙って嘘になる**。
 *    だから「そこに書いてあるパス」と「コードにある名前」を実際に見に行く。
 */
function checkRequirementsDoc(): void {
  const doc = join(ROOT, "docs", "requirements.md");
  console.log("[8] 要件定義書の照合 — requirements.md");
  if (!existsSync(doc)) {
    bad("docs/requirements.md が無い（正本がドラフトのままになっている）");
    return;
  }
  const text = readFileSync(doc, "utf8");
  // `src/sim/model.ts` のような「拡張子つきのパス」だけを見る（日本語の説明は拾わない）
  const paths = [...new Set([...text.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|py|toml|md|json))`/g)]
    .map((m) => m[1]!))].sort();
  const missing = paths.filter((p) => !existsSync(join(ROOT, p)));
  if (missing.length > 0) for (const p of missing) bad(`要件定義書が挙げているファイルが無い: ${p}`);
  else ok(`挙げられている ${paths.length}ファイルすべてが実在する`);

  // 本文が名指ししている定数が constants.ts にあるか
  const named = ["TYPE_THRESHOLD", "STOPPER_PRESS", "STRIKER_MARGIN", "ATTACK_TIE_BREAK",
                 "ACTION_CONTROL_TICKS", "TACKLE_COOLDOWN_TICKS"];
  const cited = named.filter((n) => text.includes(n));
  const gone = cited.filter((n) => !(n in C));
  if (gone.length > 0) for (const n of gone) bad(`要件定義書が名指しした定数が constants.ts に無い: ${n}`);
  else ok(`名指しされた定数 ${cited.length}件すべてが constants.ts にある`);

  // 閾値は本文にも数字で書いてある。ズレたら本文が嘘になる
  if (text.includes(`閾値は **${C.TYPE_THRESHOLD}**`)) {
    ok(`本文の閾値 ${C.TYPE_THRESHOLD} が TYPE_THRESHOLD と一致`);
  } else {
    bad(`本文の閾値が TYPE_THRESHOLD(${C.TYPE_THRESHOLD}) と食い違っている`);
  }
}

/**
 * 🔴 **どのチームにも勝ち筋と負け筋があるか**（要件 GD-05）。
 *
 * 要件定義書は「大量の自動対戦で勝ちすぎるチームがなく、戦術の相性
 * （じゃんけん関係）が生まれること」をMVPの核の1つに挙げている。
 * ここが壊れると、育成の選択が無意味になる（強い型を選ぶだけのゲームになる）。
 */
async function checkFairness(): Promise<void> {
  // 🔴 **試合数を削らない。** 1組6試合（=1チーム30試合）だと揺らぎが大きく、
  //    真の勝率35%のチームが28.3%と出て赤くなった（2026-10-01 実測）。
  // 🔑 1組20試合＝1チーム100試合。詳しく見るときは `npm run sim -- batch --matches 200`
  const matchesPerPair = 20;
  console.log(`[7] 相性（じゃんけん関係） — 6チーム総当たり × ${matchesPerPair}試合`);
  const summary = await runBatch(matchesPerPair, 1);
  const rates = summary.overall_rate;
  const badTeams = Object.entries(rates)
    .filter(([, r]) => !(C.BATCH_WIN_RATE_WARN_LOW <= r && r <= C.BATCH_WIN_RATE_WARN_HIGH))
    .map(([name, r]) => `${name} ${fmtPct(r, 1)}`);
  if (badTeams.length > 0) {
    bad(`勝率が床30%〜天井70%を外れたチーム: ${badTeams.join(", ")}（強い型を選ぶだけのゲームになっている）`);
  } else {
    const vals = Object.values(rates);
    ok(`6チームの全体勝率が ${fmtPct(Math.min(...vals), 0)}〜${fmtPct(Math.max(...vals), 0)}`
       + "（床30%〜天井70%の内側）");
  }
  // 🔑 じゃんけん（A>B>C>A の循環）があるかを**参考として**出す。
  //    2026-10-02 の確認で、各組200試合では循環が無く一本道の強さ順になっていた。
  //    バランス調整はオーナー判断なので、ここでは止めずに見えるようにだけする。
  const teams = summary.teams;
  const beats = (a: string, b: string): boolean => {
    const h = summary.head_to_head[a]![b]!;
    const n = h.w + h.d + h.l;
    return n > 0 && (h.w + 0.5 * h.d) / n > 0.5;
  };
  const cycles: string[] = [];
  for (const a of teams) for (const b of teams) for (const c of teams) {
    if (a < b && a < c && b !== c && beats(a, b) && beats(b, c) && beats(c, a)) {
      cycles.push(`${a}→${b}→${c}→${a}`);
    }
  }
  console.log(cycles.length > 0
    ? `  ℹ じゃんけんの循環 ${cycles.length}組（例: ${cycles[0]}）`
    : "  ℹ じゃんけんの循環は見つからない（強さが一本道。バランス調整の判断材料）");
}

/** 型チェック（Python 版の ruff / mypy の代わり）。ここから呼んで、人が思い出す形にしない。 */
function checkTools(): void {
  console.log("[9] 型チェック — tsc");
  try {
    execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p",
                                    join(ROOT, "tsconfig.json")], { cwd: ROOT, stdio: "pipe" });
    ok("tsc 問題なし（strict・未使用の変数や引数も検査）");
  } catch (e) {
    const out = ((e as { stdout?: Buffer }).stdout?.toString() ?? String(e)).trim().split("\n");
    bad(`tsc が問題を報告した:\n      ${out.slice(-5).join("\n      ")}`);
  }
}

/**
 * ブラウザへ配る一式が組み立てられ、**配ってはいけないものが混ざらない**こと。
 *
 * 🔴 静的配信は「置いてあるものが全部公開される」。
 *    カードショップEDENでは内部メモが `/cards/README.md` で公開されていた。
 */
/**
 * 画面のコードが名指しする id が、**配る index.html に実在する**こと。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 2026-10-02 の見た目の作り直しで分かったこと
 * ─────────────────────────────────────────────────────────────
 * `src/web/main.ts` の `$("...")` は、無い id を渡されると**その場で例外**になる。
 * ところが起きるのはブラウザで**その画面を開いた瞬間**だけで、
 * 型チェックもテストも検査も、全部緑のまま通る（DOM を見ていないので当然）。
 * 導線を変えて HTML の骨組みを動かすたびに、この踏み方が待っている。
 *
 * 🔑 だから機械で突き合わせる。**見つかるのは開く前**になる。
 */
/**
 * 入口のファイルと、その中身を載せている HTML の対応。
 *
 * 🔴 ページが2枚になった時点で、1枚だけ見る検査は**正しく赤を出した**（2026-10-03）。
 *    `lab.ts` の id は `lab.html` にあるので `index.html` には無い。
 *    検査が悪いのではなく、検査が知らない対応が増えただけ。ここに足す。
 * 🔑 入口以外（`sprites.ts` など）は `$()` を持たないので、ここに現れない。
 */
const PAGES: Record<string, string> = {
  "main.ts": "index.html",
  "lab.ts": "lab.html",
};

function checkDomContract(): void {
  let total = 0;
  const missing: string[] = [];
  for (const [entry, page] of Object.entries(PAGES)) {
    const src = readFileSync(join(ROOT, "src", "web", entry), "utf8");
    const html = readFileSync(join(DIST, page), "utf8");
    const ids = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]!));
    const want = new Set([...src.matchAll(/\$(?:<[^>]*>)?\("([\w-]+)"\)/g)]
                         .map((m) => m[1]!));
    total += want.size;
    for (const id of want) if (!ids.has(id)) missing.push(`#${id}（${entry} → ${page}）`);
  }
  if (missing.length > 0) for (const m of missing) bad(`画面のコードが要る id が無い: ${m}`);
  else ok(`画面のコードが名指しする ${total}個の id すべてが HTML にある（${
    Object.values(PAGES).join(" / ")}）`);
}

function checkWebBuild(): void {
  console.log("[10] ブラウザ配信物の組み立て — web/dist");
  const lines: string[] = [];
  if (build((l) => lines.push(l)) !== 0) {
    bad(`web/dist を組み立てられない:\n      ${lines.slice(-5).join("\n      ")}`);
    return;
  }
  // 🔴 区切り文字を `/` へそろえる（Windows の `relative()` は `\` を返す）。
  //    そろえないと下の2つの検査が**両方とも黙って通らなくなる**:
  //    ①一覧（manifest は `/`）との照合が全件「配られていない」になる
  //    ②`cli/` `node/` が混ざっていないかの検査が**一度も一致しない＝守っていない**
  const files = listFiles(DIST).map((p) => relative(DIST, p).split("\\").join("/"));
  ok(`${files.length}ファイルを組み立てた`);
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8")) as
    { stamp?: string; js: string[] };
  const missing = manifest.js.filter((f) => !files.includes(`js/${f}`));
  if (missing.length > 0) bad(`一覧にあるのに配られていない: ${JSON.stringify(missing)}`);
  else ok(`一覧の ${manifest.js.length}ファイルがすべて配信物に入っている`);
  // 🔴 端末の対話画面・ファイル入出力はブラウザでは動かない。配ると読む人が誤解する
  const unwanted = files.filter((f) => /(^|\/)(cli|node)\//.test(f) || f.endsWith("batch.js"));
  if (unwanted.length > 0) bad(`ブラウザで使わないコードが混ざっている: ${JSON.stringify(unwanted)}`);
  else ok("ブラウザで使わないコード（cli / node / batch）は入っていない");
  // 🔴 **版の刻印**（2026-09-30 に実際に踏んだ）。刻印が無いと、ブラウザが一部のファイルだけ
  //    古い写しを返し、新しいものと混ざった状態で動く。画面は普通に立ち上がるので気づけない。
  const stamp = manifest.stamp;
  if (!stamp) {
    bad("配信物に版の刻印が無い（ブラウザが古い写しを使い回す）");
    return;
  }
  const index = readFileSync(join(DIST, "index.html"), "utf8");
  checkDomContract();
  const unstamped = [...index.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css))"/g)].map((m) => m[1]);
  const imports = files.filter((f) => f.endsWith(".js")).flatMap((f) =>
    [...readFileSync(join(DIST, f), "utf8").matchAll(/from\s*"(\.{1,2}\/[\w./-]+\.js)"/g)]
      .map((m) => `${f}: ${m[1]}`));
  if (unstamped.length > 0 || imports.length > 0) {
    bad(`刻印の付いていない読み込みがある: ${JSON.stringify([...unstamped, ...imports])}`);
  } else {
    ok(`版の刻印 ${stamp} が index.html と JS どうしの読み込みの両方に入っている`);
  }
}

/** 実測スタッツを現実の相場と照合する（`scripts/measure.ts`）。 */
function checkStatRanges(): void {
  console.log("[11] 実測スタッツと現実の相場の照合 — プリセット総当たり");
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "measure.ts")], { cwd: ROOT, stdio: "pipe" });
    ok(`新しく相場を外れた指標なし（既知の赤 ${KNOWN_RED.size}件は measure.ts の KNOWN_RED）`);
  } catch (e) {
    const out = ((e as { stdout?: Buffer }).stdout?.toString() ?? String(e)).trim().split("\n");
    bad(`実測が相場から外れた:\n      ${out.slice(-8).join("\n      ")}`);
  }
}

async function main(): Promise<number> {
  console.log("=== dot-soccer 提出前検査 ===");
  checkDummyValues();
  checkConstantsInvariants();
  checkDataFiles();
  checkSpecialNames();
  checkPresets();
  checkLeagueSetup();
  await checkFairness();
  checkRequirementsDoc();
  checkTools();
  checkWebBuild();
  checkStatRanges();
  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length}件の問題があります`);
    return 1;
  }
  console.log("✅ すべて問題なし");
  return 0;
}

if (process.argv[1] === SELF) process.exitCode = await main();
