/**
 * 対話式のゲーム画面（コマンド上で遊ぶ層）。
 *
 * 入出力は**引数で受ける**（`new Console(reader, writer)`）。
 * こうしておくと、テストが人の代わりにキー入力を渡して全画面を最後まで歩ける。
 * 学習台帳「自分が作った導線を、自分で最初から最後まで一度歩く」への対処。
 */

import { existsSync, readSync } from "node:fs";
import { join } from "node:path";

import * as C from "../sim/constants.ts";
import { Career, SaveError } from "../sim/career.ts";
import type { RoundOutcome } from "../sim/career.ts";
import { ValueError } from "../sim/errors.ts";
import { formatStandings } from "../sim/league.ts";
import { ATTITUDES, FORMATIONS, Manager, POLICY_ACTIONS, POLICY_CONDITIONS, PolicyRule,
         Tactics } from "../sim/model.ts";
import { PRESET_PLANS, TRAININGS_PER_PLAYER, defaultUserPlan } from "../sim/presets.ts";
import type { Plan } from "../sim/presets.ts";
import { cmpStr, ljust, pyFloatStr, rjust, signed } from "../sim/pymath.ts";
import { CARD_KEYS, FORBIDDEN_PAIRS, getCard, pairKey, specialName } from "../sim/training.ts";
import { ROOT, loadCareer, saveCareer } from "../node/files.ts";

export const DEFAULT_SAVE = join(ROOT, "saves", "default.json");
const RULE = "─".repeat(66);

/** 入力が尽きた（EOF）か、プレイヤーが終了を選んだ。 */
export class Quit extends Error {
  override name = "Quit";
}

/** Python の `int(文字列)`（前後の空白・符号・全角数字・桁区切りの _ を受け付ける）。 */
function parsePyInt(raw: string): number | null {
  const s = raw.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!/^[+-]?\d+(_\d+)*$/.test(s)) return null;
  return Number.parseInt(s.replaceAll("_", ""), 10);
}

/** 標準入力から1行読む（同期）。尽きたら null。 */
function readLineSync(): string | null {
  const bytes: number[] = [];
  const buf = Buffer.alloc(1);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
      if ((e as NodeJS.ErrnoException).code === "EOF") n = 0;
      else throw e;
    }
    if (n === 0) return bytes.length > 0 ? Buffer.from(bytes).toString("utf8") : null;
    if (buf[0] === 0x0a) return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
    bytes.push(buf[0]!);
  }
}

export class Console {
  private readonly reader: (() => string) | null;
  private readonly writer: ((text: string) => void) | null;

  constructor(reader: (() => string) | null = null, writer: ((text: string) => void) | null = null) {
    this.reader = reader;
    this.writer = writer;
  }

  out(text = ""): void {
    if (this.writer !== null) this.writer(text);
    else process.stdout.write(`${text}\n`);
  }

  read(): string {
    if (this.reader !== null) return this.reader();
    const line = readLineSync();
    if (line === null) throw new Quit("入力が終了しました");
    return line;
  }

  ask(prompt: string, def: string | null = null): string {
    const suffix = def ? ` [${def}]` : "";
    this.out(`${prompt}${suffix}: `);
    const value = this.read().trim();
    if (!value && def !== null) return def;
    return value;
  }

  askInt(prompt: string, lo: number, hi: number, def: number | null = null): number {
    for (;;) {
      const raw = this.ask(`${prompt}（${lo}〜${hi}）`, def !== null ? String(def) : null);
      const value = parsePyInt(raw);
      if (value === null) {
        this.out(`  ⚠ 数字で入れてください（${lo}〜${hi}）`);
        continue;
      }
      if (value >= lo && value <= hi) return value;
      this.out(`  ⚠ ${lo}〜${hi} の範囲で入れてください`);
    }
  }

  /** options = [[選択キー, 表示], ...]。戻り値は選択キー。 */
  choose(prompt: string, options: [string, string][]): string {
    const keys = new Set(options.map(([k]) => k));
    for (;;) {
      for (const [key, label] of options) this.out(`  ${key}) ${label}`);
      const value = this.ask(prompt);
      if (keys.has(value)) return value;
      this.out(`  ⚠ ${options.map(([k]) => k).join("/")} のどれかを入れてください`);
    }
  }

  pause(): void {
    this.out("（Enterで続ける）");
    this.read();
  }
}

// ---------------------------------------------------------------- 表示部品

export function formatSquad(career: Career): string {
  const lines = [
    `${rjust("#", 2)} ${ljust("名前", 12)}${ljust("位", 4)}${ljust("タイプ", 12)}`
    + `${rjust("蹴", 4)}${rjust("速", 4)}${rjust("体", 4)}${rjust("技", 4)}${rjust("力", 4)}  `
    + `${rjust("ゾン/マン", 9)}${rjust("press", 6)}${rjust("sup", 5)}${rjust("ovl", 5)}`
    + `${rjust("run", 5)}${rjust("wait", 5)}`,
  ];
  career.me.allPlayers.forEach((p, i) => {
    const mark = i < C.PLAYERS_ON_PITCH ? "*" : " ";
    const h = p.hidden;
    lines.push(
      `${rjust(String(i), 2)}${mark}${ljust(p.name, 12)}${ljust(p.position, 4)}${ljust(p.typeName, 12)}`
      + `${rjust(String(p.kick), 4)}${rjust(String(p.speed), 4)}${rjust(String(p.stamina), 4)}`
      + `${rjust(String(p.technique), 4)}${rjust(String(p.physical), 4)}  `
      + `${rjust(signed(h.zone_man), 9)}${rjust(String(h.press), 6)}${rjust(String(h.support), 5)}`
      + `${rjust(String(h.overlap), 5)}${rjust(String(h.run_space), 5)}${rjust(String(h.goal_wait), 5)}`,
    );
  });
  lines.push("  * = 先発11人 ／ ゾン(-)〜マン(+)");
  return lines.join("\n");
}

function sortedCards(career: Career): [string, number][] {
  return Object.entries(career.cards).sort(([a], [b]) => cmpStr(a, b));
}

export function formatCards(career: Career): string {
  if (Object.keys(career.cards).length === 0) {
    return "  所持カード: なし（試合で課題が出るともらえます）";
  }
  const parts = sortedCards(career).map(([k, n]) => `${getCard(k).label}×${n}`);
  return `  所持カード: ${parts.join(" / ")}`;
}

export function formatTactics(career: Career): string {
  const t = career.me.tactics;
  const m = career.me.manager;
  const lines = [
    `  フォーメーション: ${t.formation}`,
    `  ライン高さ: ${t.line_height}  守備幅: ${t.zone_width}  姿勢: ${t.attitude}`,
    `  監督: 攻撃性${signed(m.style)} 徹底${signed(m.rigidity)}`
    + ` 交代${signed(m.substitution)} 起用${signed(m.selection)}`,
  ];
  if (career.me.policy.length > 0) {
    lines.push("  チーム方針（上から順に判定）:");
    career.me.policy.forEach((r, i) => lines.push(`    ${i + 1}. ${r.condition} → ${r.action}`));
  } else {
    lines.push("  チーム方針: なし");
  }
  return lines.join("\n");
}

export function formatMatchDigest(career: Career, outcome: RoundOutcome): string {
  const mine = outcome.mine;
  const res = mine.match;
  const rec = mine.record;
  const i = mine.my_index;
  const oppI = 1 - i;
  const lines = [RULE,
                 `第${rec.round}節  ${rec.home} ${rec.home_goals} - ${rec.away_goals} ${rec.away}`,
                 RULE];
  const goals = res.events.filter((e) => e.type === "ゴール");
  if (goals.length > 0) {
    lines.push("  得点:");
    for (const g of goals) lines.push(`    ${g.time}  ${g.team}  ${g.player}`);
  } else {
    lines.push("  得点なし");
  }
  const ms = res.stats[i]!;
  const os = res.stats[oppI]!;
  // 🔑 支配率などは Python では小数（50.0）。JS の数は 50 と出るので小数点を補う
  const f = pyFloatStr;
  lines.push(`  シュート ${ms.shots} - ${os.shots}`
             + `   支配率 ${f(ms.possession_pct)}% - ${f(os.possession_pct)}%`
             + `   パス成功 ${f(ms.pass_success_pct)}% - ${f(os.pass_success_pct)}%`);
  lines.push(`  ボール奪取 ${ms.tackles_won} - ${os.tackles_won}`
             + `   オフサイド ${ms.offsides} - ${os.offsides}`
             + `   走行 ${f(ms.distance_km)}km - ${f(os.distance_km)}km`);
  const subs = res.events.filter((e) => e.type === "交代" && e.team === career.user_team);
  if (subs.length > 0) lines.push(`  交代: ${subs.map((e) => e.detail).join(" / ")}`);
  const fired = res.events.filter((e) => e.type === "方針の発動" && e.team === career.user_team);
  if (fired.length > 0) {
    lines.push(`  チーム方針が発動: ${fired.length}回（${fired[0]!.detail} など）`);
  }
  if (mine.awarded.length > 0) {
    lines.push("  🎴 特訓カードを獲得:");
    for (const key of mine.awarded) {
      lines.push(`    「${getCard(key).label}」 ← ${getCard(key).issue}`);
    }
  } else {
    lines.push("  課題なし（カードの獲得なし）");
  }
  if (outcome.others.length > 0) {
    lines.push(`  他会場: ${outcome.others
      .map((r) => `${r.home} ${r.home_goals}-${r.away_goals} ${r.away}`).join(" / ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- ゲーム本体

export class Game {
  private readonly c: Console;
  private readonly savePath: string;
  private career: Career | null = null;

  constructor(console: Console, savePath: string = DEFAULT_SAVE) {
    this.c = console;
    this.savePath = savePath;
  }

  private get car(): Career {
    if (this.career === null) throw new Error("ゲームが始まっていない");
    return this.career;
  }

  // ------------------------------------------------------------ 起動
  run(): number {
    this.c.out();
    this.c.out("=".repeat(66));
    this.c.out("  ドットサッカー育成ゲーム（MVP・コマンド版）");
    this.c.out("=".repeat(66));
    try {
      this.start();
      this.mainLoop();
    } catch (e) {
      if (!(e instanceof Quit)) throw e;
      this.c.out(`\n${e.message}`);
      if (this.career !== null) this.save(false);
      this.c.out("またお待ちしています。");
      return 0;
    }
    return 0;
  }

  private start(): void {
    if (existsSync(this.savePath)) {
      this.c.out(`\nセーブデータがあります: ${this.savePath}`);
      const choice = this.c.choose("選んでください", [
        ["1", "続きから遊ぶ"],
        ["2", "新しく始める（今のセーブは上書きされます）"],
        ["0", "やめる"],
      ]);
      if (choice === "0") throw new Quit("終了します。");
      if (choice === "1") {
        try {
          this.career = loadCareer(this.savePath);
        } catch (e) {
          if (!(e instanceof SaveError)) throw e;
          this.c.out(`  ⚠ 読み込めませんでした: ${e.message}`);
          this.c.out("  新しく始めます。");
        }
        if (this.career !== null) {
          this.c.out(`  ${this.career.user_team} / ${this.career.season}シーズン目 `
                     + `第${this.career.round_index + 1}節から`);
          return;
        }
      }
    }
    this.career = this.newGame();
    this.save(true);
  }

  private newGame(): Career {
    this.c.out("\n--- 新しいチームを作ります ---");
    for (;;) {
      const name = this.c.ask("チーム名", "わがチーム");
      if (!name) {
        this.c.out("  ⚠ チーム名を入れてください");
        continue;
      }
      try {
        const seed = this.c.askInt("運の種（同じ数字なら同じ展開になります）", 1, 999999, 1);
        const formations = Object.keys(FORMATIONS);
        this.c.out("  フォーメーション:");
        const key = this.c.choose("番号", formations.map((f, i) => [String(i + 1), f]));
        const formation = formations[Number(key) - 1]!;
        const plan = this.chooseInitialPlan();
        return Career.newGame(name, seed, formation, plan);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        this.c.out(`  ⚠ ${e.message}`);
      }
    }
  }

  private chooseInitialPlan(): Plan {
    this.c.out();
    this.c.out(`  初期育成: 全選手に特訓を${TRAININGS_PER_PLAYER}回行います。`);
    this.c.out("  （AIチームも同じ回数だけ育った状態で開幕します。"
               + "配分がチームの個性になります）");
    const names = Object.keys(PRESET_PLANS);
    const options: [string, string][] = names.map((name, i) => [String(i + 1), `${name}と同じ配分`]);
    options.push(["9", "自分で配分する"]);
    const key = this.c.choose("選んでください", options);
    if (key !== "9") {
      const name = names[Number(key) - 1]!;
      const plan = { ...PRESET_PLANS[name]![0] };
      this.c.out(`  → ${name}と同じ配分: `
                 + Object.entries(plan).map(([k, v]) => `${getCard(k).label}${v}回`).join(" / "));
      return plan;
    }
    return this.customPlan();
  }

  private customPlan(): Plan {
    for (;;) {
      let plan: Plan = {};
      let remaining = TRAININGS_PER_PLAYER;
      const keys = CARD_KEYS;
      for (const [i, key] of keys.entries()) {
        if (remaining === 0) break;
        const last = i === keys.length - 1;
        if (last) {
          this.c.out(`  「${getCard(key).label}」に残り全部（${remaining}回）を割り当てます`);
          plan[key] = remaining;
          remaining = 0;
          break;
        }
        const n = this.c.askInt(`「${getCard(key).label}」に何回？ 残り${remaining}回`,
                                0, remaining, 0);
        if (n) plan[key] = n;
        remaining -= n;
      }
      if (remaining > 0) {
        this.c.out(`  ⚠ ${remaining}回あまりました。もう一度配分してください。`);
        continue;
      }
      if (Object.values(plan).reduce((a, b) => a + b, 0) !== TRAININGS_PER_PLAYER) {
        this.c.out("  ⚠ 合計が合いません。もう一度。");
        continue;
      }
      plan = Object.fromEntries(Object.entries(plan).filter(([, v]) => v > 0));
      if (Object.keys(plan).length === 0) plan = defaultUserPlan();
      this.c.out(`  → ${Object.entries(plan).map(([k, v]) => `${getCard(k).label}${v}回`).join(" / ")}`);
      return plan;
    }
  }

  // ------------------------------------------------------------ メイン
  private mainLoop(): void {
    for (;;) {
      const car = this.car;
      this.c.out();
      this.c.out(RULE);
      let head: string;
      if (car.seasonFinished) {
        head = `${car.season}シーズン目 — 全${car.totalRounds}節 終了`;
      } else {
        const nxt = car.myNextMatch();
        const opponent = nxt && nxt[0] === car.user_team ? nxt[1] : (nxt ? nxt[0] : "—");
        const where = nxt && nxt[0] === car.user_team ? "ホーム" : "アウェー";
        head = `${car.season}シーズン目 第${car.round_index + 1}節/${car.totalRounds}`
               + `  次の相手: ${opponent}（${where}）`;
      }
      this.c.out(`  ${car.user_team}  ${car.myRank()}位  ${head}`);
      this.c.out(formatCards(car));
      this.c.out(RULE);
      const key = this.c.choose("何をしますか", [
        ["1", car.seasonFinished ? "シーズンを締める" : "次の試合へ"],
        ["2", "選手と特訓"],
        ["3", "戦術を決める"],
        ["4", "順位表と日程"],
        ["5", "セーブする"],
        ["0", "セーブしてやめる"],
      ]);
      if (key === "1") {
        if (car.seasonFinished) this.screenSeasonEnd();
        else this.screenNextMatch();
      } else if (key === "2") {
        this.screenSquad();
      } else if (key === "3") {
        this.screenTactics();
      } else if (key === "4") {
        this.screenTable();
      } else if (key === "5") {
        this.save(false);
      } else if (key === "0") {
        this.save(false);
        throw new Quit("終了します。");
      }
    }
  }

  // ------------------------------------------------------------ 各画面
  private screenNextMatch(): void {
    const car = this.car;
    const fixture = car.myNextMatch();
    if (fixture === null) {
      // 🔴 8チームの総当たりでは起きない。起きたら**日程が壊れている**ので、
      //    そう読める形で止める
      throw new Error(`第${car.round_index + 1}節の日程に ${car.user_team} の試合が無い`);
    }
    this.c.out();
    this.c.out(`  第${car.round_index + 1}節: ${fixture[0]} vs ${fixture[1]}`);
    this.c.out(formatTactics(car));
    if (this.c.choose("この戦術で試合をしますか", [["1", "する"], ["2", "戦術を見直す"]]) === "2") {
      this.screenTactics();
      return;
    }
    const outcome = car.playRound();
    this.c.out(formatMatchDigest(car, outcome));
    this.save(true);
    this.c.out();
    this.c.out(formatStandings(car.standings(), car.user_team));
    if (car.seasonFinished) {
      this.c.out();
      this.c.out("  ★ 全節終了です。メニューの「シーズンを締める」へ。");
    }
    this.c.pause();
  }

  private screenSeasonEnd(): void {
    const car = this.car;
    const summary = car.finishSeason();
    this.c.out();
    this.c.out(RULE);
    this.c.out(`  ${summary.season}シーズン目 終了 — ${car.user_team} は `
               + `${summary.rank}位 / ${car.teamNames.length}チーム`);
    this.c.out(RULE);
    this.c.out(formatStandings(summary.table, car.user_team));
    this.c.out();
    this.c.out(`  AIチームも1シーズンで${C.AI_TRAININGS_PER_SEASON}回ずつ特訓しました。`);
    this.c.out(`  → ${car.season}シーズン目が始まります。`);
    this.save(true);
    this.c.pause();
  }

  private screenSquad(): void {
    const car = this.car;
    for (;;) {
      this.c.out();
      this.c.out(formatSquad(car));
      this.c.out(formatCards(car));
      const key = this.c.choose("どうしますか", [
        ["1", "特訓する"], ["2", "先発を入れ替える"], ["0", "戻る"]]);
      if (key === "0") return;
      if (key === "1") this.doTraining();
      else if (key === "2") this.swapStarter();
    }
  }

  private doTraining(): void {
    const car = this.car;
    if (Object.keys(car.cards).length === 0) {
      this.c.out("  ⚠ 所持カードがありません。試合で課題が出るともらえます。");
      return;
    }
    const squad = car.me.allPlayers;
    const idx = this.c.askInt("誰を育てますか（#）", 0, squad.length - 1, 0);
    const stock = sortedCards(car);
    this.c.out("  使えるカード:");
    stock.forEach(([k, n], i) => {
      const card = getCard(k);
      this.c.out(`    ${i + 1}) ${card.label}×${n}  `
                 + `（${card.visible_key}+${card.visible_gain} / `
                 + `${card.hidden_key}${signed(card.hidden_gain)}）`);
    });
    const first = this.c.askInt("1枚目（番号）", 1, stock.length, 1);
    const cardKeys = [stock[first - 1]![0]];
    if (this.c.choose("2枚使ってスペシャルにしますか", [["1", "しない"], ["2", "する"]]) === "2") {
      const second = this.c.askInt("2枚目（番号）", 1, stock.length, 1);
      cardKeys.push(stock[second - 1]![0]);
      const [a, b] = cardKeys as [string, string];
      if (a !== b && FORBIDDEN_PAIRS.has(pairKey(a, b))) {
        this.c.out(`  ⚠ ${getCard(a).label} と ${getCard(b).label} は`
                   + "打ち消し合うので同時に使えません。");
        return;
      }
      if (a === b) {
        this.c.out("  ⚠ スペシャルは違う2枚で作ります。");
        return;
      }
      this.c.out(`  スペシャル: 「${specialName(a, b)}」`);
    }
    let result;
    try {
      result = car.trainPlayer(idx, cardKeys);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      this.c.out(`  ⚠ ${e.message}`);
      return;
    }
    const player = car.me.allPlayers[idx]!;
    this.c.out(`  ▷ ${result.player} に「${result.label}」`);
    for (const [k, v] of Object.entries(result.deltas)) {
      const before = result.visible_before[k] ?? result.hidden_before[k]!;
      const after = player.get(k as never);
      const capped = after - before < v ? "（上限）" : "";
      this.c.out(`      ${k}: ${before} → ${after} (${signed(v)})${capped}`);
    }
    if (result.before !== result.after) {
      this.c.out(`      ★ タイプが変わった: ${result.before} → ${result.after}`);
    } else {
      this.c.out(`      タイプ: ${result.after}（変化なし）`);
    }
    this.save(true);
  }

  private swapStarter(): void {
    const car = this.car;
    const a = this.c.askInt("先発から外す選手（#）", 0, C.PLAYERS_ON_PITCH - 1, 0);
    const outP = car.me.players[a]!;
    // 控えのどれが入れられるかを先に見せる。控えの先頭はGKなので、
    // 番号だけ示して「好きに選べ」にすると必ずGKとの不一致を踏む。
    const wantGk = outP.position === "GK";
    const candidates = car.me.bench
      .map((p, i): [number, typeof p] => [C.PLAYERS_ON_PITCH + i, p])
      .filter(([, p]) => (p.position === "GK") === wantGk);
    if (candidates.length === 0) {
      const kind = wantGk ? "GK" : "フィールド選手";
      this.c.out(`  ⚠ 控えに入れ替えられる${kind}がいません。`);
      return;
    }
    this.c.out(`  ${outP.name}（${outP.position}）と入れ替えられる控え:`);
    for (const [idx, p] of candidates) this.c.out(`    ${idx}) ${p.name}  ${p.position}  ${p.typeName}`);
    const b = this.c.askInt("先発に入れる選手（#）", candidates[0]![0],
                            candidates[candidates.length - 1]![0], candidates[0]![0]);
    const inP = car.me.bench[b - C.PLAYERS_ON_PITCH]!;
    if ((outP.position === "GK") !== (inP.position === "GK")) {
      this.c.out("  ⚠ GKはGKとだけ入れ替えられます（先発のGKは必ず1人）。");
      return;
    }
    car.me.players[a] = inP;
    car.me.bench[b - C.PLAYERS_ON_PITCH] = outP;
    this.c.out(`  ▷ ${outP.name} ⇄ ${inP.name}`);
    this.save(true);
  }

  private screenTactics(): void {
    const car = this.car;
    for (;;) {
      this.c.out();
      this.c.out(formatTactics(car));
      const key = this.c.choose("何を変えますか", [
        ["1", "フォーメーション"], ["2", "ライン高さ・守備幅・姿勢"],
        ["3", "チーム方針"], ["4", "監督の性格"], ["0", "戻る"]]);
      if (key === "0") {
        this.save(true);
        return;
      }
      const t = car.me.tactics;
      if (key === "1") {
        const formations = Object.keys(FORMATIONS);
        const pick = this.c.choose("番号", formations.map((f, i) => [String(i + 1), f]));
        car.me.tactics = new Tactics({ line_height: t.line_height, zone_width: t.zone_width,
                                       attitude: t.attitude, formation: formations[Number(pick) - 1]! });
      } else if (key === "2") {
        const line = this.c.askInt("ライン高さ（低い1〜高い5）", 1, 5, t.line_height);
        const width = this.c.askInt("守備幅（狭い1〜広い5）", 1, 5, t.zone_width);
        const pick = this.c.choose("姿勢", ATTITUDES.map((a, i) => [String(i + 1), a]));
        car.me.tactics = new Tactics({ line_height: line, zone_width: width,
                                       attitude: ATTITUDES[Number(pick) - 1]!, formation: t.formation });
      } else if (key === "3") {
        this.editPolicy();
      } else if (key === "4") {
        const m = car.me.manager;
        car.me.manager = new Manager({
          style: this.c.askInt("攻撃性（守備的-2〜攻撃的+2）", -2, 2, m.style),
          rigidity: this.c.askInt("徹底度（弾力的-2〜徹底的+2）", -2, 2, m.rigidity),
          substitution: this.c.askInt("交代（消極的-2〜積極的+2）", -2, 2, m.substitution),
          selection: this.c.askInt("起用（安定感-2〜期待感+2）", -2, 2, m.selection),
        });
      }
    }
  }

  private editPolicy(): void {
    const car = this.car;
    for (;;) {
      this.c.out();
      if (car.me.policy.length > 0) {
        car.me.policy.forEach((r, i) => this.c.out(`    ${i + 1}. ${r.condition} → ${r.action}`));
      } else {
        this.c.out("    （方針なし）");
      }
      this.c.out(`    最大${C.POLICY_MAX_RULES}個。上から順に判定し、最初に当てはまった1つだけ実行。`);
      const key = this.c.choose("どうしますか", [["1", "追加する"], ["2", "削除する"], ["0", "戻る"]]);
      if (key === "0") return;
      if (key === "1") {
        if (car.me.policy.length >= C.POLICY_MAX_RULES) {
          this.c.out(`  ⚠ 方針は最大${C.POLICY_MAX_RULES}個です。`);
          continue;
        }
        this.c.out("  条件:");
        const ci = this.c.choose("番号", POLICY_CONDITIONS.map((c, i) => [String(i + 1), c]));
        this.c.out("  行動:");
        const ai = this.c.choose("番号", POLICY_ACTIONS.map((a, i) => [String(i + 1), a]));
        car.me.policy.push(new PolicyRule(POLICY_CONDITIONS[Number(ci) - 1]!,
                                          POLICY_ACTIONS[Number(ai) - 1]!));
      } else if (key === "2") {
        if (car.me.policy.length === 0) continue;
        const n = this.c.askInt("何番を削除しますか", 1, car.me.policy.length, 1);
        const [removed] = car.me.policy.splice(n - 1, 1);
        this.c.out(`  ▷ 削除: ${removed!.condition} → ${removed!.action}`);
      }
    }
  }

  private screenTable(): void {
    const car = this.car;
    this.c.out();
    this.c.out(formatStandings(car.standings(), car.user_team));
    this.c.out();
    const remaining = car.schedule.slice(car.round_index);
    if (remaining.length > 0) {
      this.c.out("  残りの日程（自チームのみ）:");
      remaining.forEach((rnd, offset) => {
        for (const [home, away] of rnd) {
          if (home === car.user_team || away === car.user_team) {
            const where = home === car.user_team ? "H" : "A";
            const opp = home === car.user_team ? away : home;
            this.c.out(`    第${car.round_index + offset + 1}節  ${where}  ${opp}`);
          }
        }
      });
    } else {
      this.c.out("  残りの日程はありません。");
    }
    if (car.history.length > 0) {
      this.c.out();
      this.c.out(`  過去の成績: ${car.history.map((h) => `${h.season}季 ${h.rank}位`).join(" / ")}`);
    }
    this.c.pause();
  }

  // ------------------------------------------------------------ 保存
  private save(quiet: boolean): void {
    if (this.career === null) return;
    const path = saveCareer(this.career, this.savePath);
    if (!quiet) this.c.out(`  💾 セーブしました: ${path}`);
  }
}

/** ゲームを起動する。`inputs` を渡すと無人で走る（テスト用）。 */
export function playGame(savePath: string = DEFAULT_SAVE, inputs: string[] | null = null,
                         writer: ((text: string) => void) | null = null): number {
  let console: Console;
  if (inputs !== null) {
    let i = 0;
    const reader = (): string => {
      if (i >= inputs.length) throw new Quit("入力が終了しました");
      return inputs[i++]!;
    };
    console = new Console(reader, writer);
  } else {
    console = new Console(null, writer);
  }
  return new Game(console, savePath).run();
}
