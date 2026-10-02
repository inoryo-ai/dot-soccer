/**
 * コマンドライン入口（要件定義書 §11）。
 *
 *     node src/cli/main.ts match data/team_a.json data/team_b.json --seed 1
 *     node src/cli/main.ts train --card running --times 20
 *     node src/cli/main.ts batch --matches 200 --seed 1
 *     node src/cli/main.ts presets            # data/ のチームJSONを作り直す
 *     node src/cli/main.ts play               # ゲームとして遊ぶ
 *
 * （`npm run sim -- <コマンド>` でも同じ。）
 */

import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as C from "../sim/constants.ts";
import { play } from "../sim/engine.ts";
import type { MatchStatsOut } from "../sim/engine.ts";
import { formatTable } from "../sim/batch.ts";
import { Player } from "../sim/model.ts";
import { PRESET_ORDER, abilityTotals, checkNoClamping } from "../sim/presets.ts";
import { fmtF, ljust, pyFloatStr, rjust } from "../sim/pymath.ts";
import { CARDS, CARD_KEYS, applyTraining, getCard, issueText, specialName } from "../sim/training.ts";
import { runBatch } from "../node/batch_pool.ts";
import { ROOT, loadTeam, writeCsv, writeDataFiles, writeJson } from "../node/files.ts";
import { DEFAULT_SAVE, playGame } from "./ui.ts";

type Out = (line?: string) => void;
const stdout: Out = (line = "") => { process.stdout.write(`${line}\n`); };
const stderr: Out = (line = "") => { process.stderr.write(`${line}\n`); };

function fmtStats(name: string, s: MatchStatsOut): string {
  const f = pyFloatStr;
  return (`  ${name}\n`
    + `    得点 ${s.goals}  シュート ${s.shots}  被シュート ${s.shots_against}\n`
    + `    支配率 ${f(s.possession_pct)}%  パス ${s.passes_completed}/${s.passes}`
    + ` (${f(s.pass_success_pct)}%)\n`
    + `    ボール奪取 ${s.tackles_won}  奪い合い ${s.duels}回中 ${s.duels_lost}敗`
    + `  裏を取られた ${s.beaten_behind}\n`
    + `    走行距離 ${f(s.distance_km)}km  スタミナ20%未満になった選手 `
    + `${s.stamina_low_players}人`);
}

export function cmdMatch(teamA: string, teamB: string, seed: number, logDir: string | null,
                         out: Out = stdout): number {
  const a = loadTeam(teamA);
  const b = loadTeam(teamB);
  const started = performance.now();
  const res = play(a, b, seed, true);
  const elapsed = (performance.now() - started) / 1000;

  out(`== ${res.teams[0]} ${res.score[0]} - ${res.score[1]} ${res.teams[1]} ==`);
  out(`   seed=${res.seed}  ${res.ticks}ティック（90分）  実行 ${fmtF(elapsed, 2)}秒`);
  out("\n[スタッツ]");
  res.teams.forEach((name, i) => out(fmtStats(name, res.stats[i]!)));
  out("\n[課題（次にもらえる特訓カード）]");
  res.teams.forEach((name, i) => {
    const issues = res.issues[i]!;
    if (issues.length > 0) for (const key of issues) out(`  ${name}: ${issueText(key)}`);
    else out(`  ${name}: なし`);
  });

  const dir = logDir ?? join(ROOT, "logs");
  const logPath = join(dir, `match_seed${res.seed}.json`);
  writeJson(logPath, res);
  out(`\nログ: ${logPath}（${res.events.length}件のイベント）`);
  return 0;
}

function newTestSubject(): Player {
  return new Player({ name: "検証くん", position: "MF", kick: 40, speed: 40, stamina: 40,
                      technique: 40, physical: 40 });
}

export function cmdTrain(cards: string[], times: number, out: Out = stdout, err: Out = stderr): number {
  if (cards.length !== 1 && cards.length !== 2) {
    err("--card は1回（通常）か2回（スペシャル）指定する");
    return 2;
  }
  for (const c of cards) {
    if (!(c in CARDS)) {
      err(`未知のカード: ${c}（使えるのは ${CARD_KEYS.join(", ")}）`);
      return 2;
    }
  }
  let label: string;
  if (cards.length === 2) {
    try {
      label = specialName(cards[0]!, cards[1]!);
    } catch (e) {
      err(`エラー: ${(e as Error).message}`);
      return 2;
    }
  } else {
    label = getCard(cards[0]!).label;
  }

  const p = newTestSubject();
  out(`== 特訓検証: ${label} × ${times}回 ==`);
  out(`   初期タイプ: ${p.typeName}`);
  const head = ["回", "zone_man", "press", "support", "overlap", "run_space", "goal_wait", "タイプ"];
  out(head.map((h) => rjust(h, 9)).join(" "));
  let changes = 0;
  let firstChange: number | null = null;
  let prev = p.typeName;
  for (let i = 1; i <= times; i++) {
    const r = applyTraining(p, cards);
    const h = p.hidden;
    const mark = r.after !== prev ? "  ←変化" : "";
    if (r.after !== prev) {
      changes += 1;
      if (firstChange === null) firstChange = i;
      prev = r.after;
    }
    const row = [String(i), ...(["zone_man", "press", "support", "overlap", "run_space",
                                 "goal_wait"] as const).map((k) => String(h[k]))];
    out(`${row.map((c) => rjust(c, 9)).join(" ")} ${p.typeName}${mark}`);
  }
  out(`\n   タイプが変わった回数: ${changes}回`
      + `（初回 ${firstChange ? firstChange : "—"}回目）`);
  out(`   最終タイプ: ${p.typeName}`);
  out(`   見える能力: ${Object.entries(p.visible).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  return 0;
}

/** 完成条件の「6種カードのタイプ変化回数一覧」（実際は D-02 で7種）。 */
export function cmdTrainAll(times: number, out: Out = stdout): number {
  out(`== 全カードのタイプ変化回数（各 ${times}回） ==`);
  out(`${ljust("カード", 14)}${rjust("変化回数", 8)}${rjust("初回", 6)}  最終タイプ`);
  for (const [key, card] of Object.entries(CARDS)) {
    const p = newTestSubject();
    let prev = p.typeName;
    let changes = 0;
    let first: number | null = null;
    for (let i = 1; i <= times; i++) {
      applyTraining(p, [key]);
      if (p.typeName !== prev) {
        changes += 1;
        first = first || i;
        prev = p.typeName;
      }
    }
    out(`${ljust(card.label, 14)}${rjust(String(changes), 8)}${rjust(first ? String(first) : "—", 6)}`
        + `  ${p.typeName}`);
  }
  return 0;
}

async function cmdBatch(matches: number, seed: number, workers: number | null, outPath: string | null,
                        strict: boolean): Promise<number> {
  const progress = (done: number, total: number): void => {
    process.stderr.write(`\r  ${done}/${total} 試合 ...`);
  };
  const n = PRESET_ORDER.length;
  const total = matches * (n * (n - 1) / 2);
  stdout(`== 総当たり ${n}チーム / 各組${matches}試合 = ${total}試合 ==`);
  const started = performance.now();
  const summary = await runBatch(matches, seed, workers, PRESET_ORDER, progress);
  const elapsed = (performance.now() - started) / 1000;
  stdout(`\r  完了: ${summary.total_matches}試合 / ${fmtF(elapsed, 1)}秒`
         + `（1試合あたり ${fmtF(elapsed / Math.max(1, summary.total_matches) * 1000, 0)}ms）`);
  stdout();
  stdout(formatTable(summary));
  stdout();
  if (summary.warnings.length > 0) {
    for (const w of summary.warnings) stdout(w);
  } else {
    stdout(`✅ 全チームの全体勝率が ${fmtF(C.BATCH_WIN_RATE_WARN_LOW * 100, 0)}%〜`
           + `${fmtF(C.BATCH_WIN_RATE_WARN_HIGH * 100, 0)}% の範囲に収まっている`);
  }
  const csvPath = outPath ?? join(ROOT, "out", "batch_winrate.csv");
  writeCsv(summary, csvPath);
  stdout(`CSV: ${csvPath}`);
  return summary.warnings.length > 0 && strict ? 1 : 0;
}

function cmdPresets(dataDir: string | null): number {
  const dir = dataDir ?? join(ROOT, "data");
  const written = writeDataFiles(dir);
  stdout(`== プリセット書き出し: ${written.length}件 → ${dir} ==`);
  for (const p of written) stdout(`  ${p.split("/").pop()}`);
  stdout("\n[能力合計（そろっているか）]");
  for (const [name, total] of Object.entries(abilityTotals())) stdout(`  ${name}: ${total}`);
  const problems = checkNoClamping();
  if (problems.length > 0) {
    for (const problem of problems) stdout(`⚠ ${problem}`);
    return 1;
  }
  stdout("✅ 全チームの能力合計が一致（上限で切られていない）");
  return 0;
}

// ---------------------------------------------------------------- 引数

const USAGE = `使い方: node src/cli/main.ts <コマンド> [オプション]

  match <team_a.json> <team_b.json> [--seed N] [--log-dir DIR]   1試合を実行する
  train --card KEY [--card KEY] [--times N]                      特訓を繰り返してタイプ変化を見る
  train-all [--times N]                                          全カードのタイプ変化回数一覧
  batch [--matches N] [--seed N] [--workers N] [--out PATH] [--strict]
                                                                 プリセット総当たりの大量対戦
  play [--save PATH]                                             ゲームとして遊ぶ
  presets [--data-dir DIR]                                       data/ のチームJSONを作り直す

カード: ${Object.keys(CARDS).join(", ")}`;

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  options: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgs(argv: string[], valueOptions: string[], flagOptions: string[]): Parsed {
  const parsed: Parsed = { positional: [], options: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (flagOptions.includes(name)) {
        parsed.flags.add(name);
      } else if (valueOptions.includes(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`--${name} に値がありません`);
        parsed.options.set(name, [...(parsed.options.get(name) ?? []), value]);
      } else {
        throw new UsageError(`知らないオプション: ${a}`);
      }
    } else {
      parsed.positional.push(a);
    }
  }
  return parsed;
}

function intOption(p: Parsed, name: string, def: number): number {
  const v = p.options.get(name)?.at(-1);
  if (v === undefined) return def;
  if (!/^[+-]?\d+$/.test(v)) throw new UsageError(`--${name} は整数: ${v}`);
  return Number.parseInt(v, 10);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "match": {
        const p = parseArgs(rest, ["seed", "log-dir"], []);
        if (p.positional.length !== 2) throw new UsageError("match にはチームJSONを2つ渡す");
        return cmdMatch(p.positional[0]!, p.positional[1]!, intOption(p, "seed", 1),
                        p.options.get("log-dir")?.at(-1) ?? null);
      }
      case "train": {
        const p = parseArgs(rest, ["card", "times"], []);
        const cards = p.options.get("card") ?? [];
        if (cards.length === 0) throw new UsageError("--card を指定する");
        return cmdTrain(cards, intOption(p, "times", 20));
      }
      case "train-all": {
        const p = parseArgs(rest, ["times"], []);
        return cmdTrainAll(intOption(p, "times", 20));
      }
      case "batch": {
        const p = parseArgs(rest, ["matches", "seed", "workers", "out"], ["strict"]);
        const workers = p.options.has("workers") ? intOption(p, "workers", 1) : null;
        return await cmdBatch(intOption(p, "matches", 200), intOption(p, "seed", 1), workers,
                              p.options.get("out")?.at(-1) ?? null, p.flags.has("strict"));
      }
      case "play": {
        const p = parseArgs(rest, ["save"], []);
        return playGame(p.options.get("save")?.at(-1) ?? DEFAULT_SAVE);
      }
      case "presets": {
        const p = parseArgs(rest, ["data-dir"], []);
        return cmdPresets(p.options.get("data-dir")?.at(-1) ?? null);
      }
      case undefined:
      case "-h":
      case "--help":
        stdout(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`知らないコマンド: ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      stderr(`エラー: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 🔑 `| head` などで読み手が先に閉じたら、黙って終える（EPIPE で落ちて長いエラーを出さない）
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE") process.exit(0);
      throw e;
    });
  }
  process.exitCode = await main(process.argv.slice(2));
}
