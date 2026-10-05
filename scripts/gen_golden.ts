/**
 * 正解データのうち、**試合の規則で結果が変わるもの**を TypeScript 版で作り直す。
 *
 *     node scripts/gen_golden.ts      # matches / batch / career / cli を書き直す
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 規則を変えたときだけ使う
 * ─────────────────────────────────────────────────────────────
 * 正解データは元々 Python 版（コミット 8b126f0）が書き出したもので、
 * 書き直しで意図せず結果が変わっていないことを確かめるためにあった（D-15）。
 * 規則を変えれば一致しなくなるのは正しい変化なので、変えた規則を `docs/decisions.md` に
 * 書いたうえで、ここで作り直す（D-18）。
 *
 * 🔑 乱数・数学・プリセット・特訓（random / math / presets / training）は規則と関係ないので
 *    作り直さない。こちらは今も Python 版との照合のまま。ただし特訓の正解データの**課題の判定**は
 *    規則（課題の線・D-51）なので作り直す（`genTrainingIssues`）。
 * 🔑 試合の組み合わせ・シード・入力は、いまの正解データにあるものをそのまま使い、結果だけを
 *    書き直す（テストと同じ条件で作るため）。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdMatch, cmdTrain, cmdTrainAll } from "../src/cli/main.ts";
import { playGame } from "../src/cli/ui.ts";
import { formatTable, runBatchSerial } from "../src/sim/batch.ts";
import { Career } from "../src/sim/career.ts";
// 🔑 D-51: ゲームの試合は新エンジン。正解データも新エンジンで固定する（旧エンジンは tests/sim.test.ts などが固定）
import { playNew as play } from "../src/sim/match/game.ts";
import { formatStandings } from "../src/sim/league.ts";
import { Team } from "../src/sim/model.ts";
import { buildPreset } from "../src/sim/presets.ts";
import { cmpStr } from "../src/sim/pymath.ts";
import { findIssues } from "../src/sim/training.ts";
import { ROOT, golden, maskSaveDir } from "../tests/helpers.ts";

const OUT = join(ROOT, "tests", "golden");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const plain = <T>(v: T): any => JSON.parse(JSON.stringify(v));

function dump(name: string, obj: unknown): void {
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(obj)}\n`, "utf8");
  console.log(`  ${name}.json`);
}

function genMatches(): void {
  const g = golden<any>("matches");
  const matches = g.matches.map((m: any, k: number) => {
    const res: any = plain(play(buildPreset(m.home), buildPreset(m.away), m.seed, true));
    // 7試合目からは経過をハッシュだけにする（量を抑える。Python 版と同じ）
    if (k >= 6) {
      res.events_count = res.events.length;
      res.events_sha256 = sha256(JSON.stringify(res.events));
      delete res.events;
    }
    return { home: m.home, away: m.away, seed: m.seed, result: res };
  });

  const res = play(buildPreset("堅守型"), buildPreset("パス型"), 77, true, true);
  const { replay: rep, ...rest } = res;
  if (rep === undefined) throw new Error("再生データが無い");
  const replay = {
    sample_ticks: rep.sample_ticks, coord_scale: rep.coord_scale, pitch: rep.pitch,
    roster: rep.roster,
    frame_count: rep.frames.length,
    frames_sha256: sha256(JSON.stringify(rep.frames)),
    first_frames: rep.frames.slice(0, 3),
    last_frame: rep.frames[rep.frames.length - 1],
  };

  const c = g.custom;
  const custom = play(Team.fromDict(c.home), Team.fromDict(c.away), c.seed, true);
  dump("matches", {
    matches,
    replay_match: { result: plain(rest), replay: plain(replay) },
    custom: { home: c.home, away: c.away, seed: c.seed, result: plain(custom) },
  });
}

function genBatch(): void {
  const summary = runBatchSerial(2, 3);
  dump("batch", { summary: plain(summary), table: formatTable(summary) });
}

/** `tests/golden.test.ts` のキャリアの検査と同じ手順で回す。 */
function genCareer(): void {
  const car = Career.newGame("フェニックス", 11, "3-5-2", { pass: 8, dash: 6, shoot: 6 });
  const log: any = { start: car.toDict(), rounds: [] };
  for (let season = 0; season < 2; season++) {
    while (!car.seasonFinished) {
      const out: any = car.playRound();
      delete out.mine.match.events;
      const trained: unknown[] = [];
      for (const key of Object.keys(car.cards).sort(cmpStr)) {
        if ((car.cards[key] ?? 0) >= 1) trained.push(car.trainPlayer(trained.length % 16, [key]));
      }
      const keys = Object.keys(car.cards).sort(cmpStr);
      if (keys.length >= 2 && !(keys[0] === "man_mark" && keys[1] === "zone")) {
        trained.push(car.trainPlayer(3, keys.slice(0, 2)));
      }
      log.rounds.push({ outcome: out, trained, standings: car.standings(), cards: { ...car.cards } });
    }
    log.rounds.push({ finish: car.finishSeason() });
  }
  log.end = car.toDict();
  dump("career", plain(log));
}

function capture(fn: (out: (line?: string) => void) => void): string {
  const lines: string[] = [];
  fn((line = "") => { lines.push(line); });
  return lines.map((l) => `${l}\n`).join("");
}

/** `tests/cli.test.ts` と同じ手順で回す。 */
function genCli(): void {
  const g = golden<any>("cli");
  const out: any = {};
  out.train_running = capture((o) => cmdTrain(["running"], 20, o));
  out.train_special = capture((o) => cmdTrain(["man_mark", "running"], 20, o));
  out.train_all = capture((o) => cmdTrainAll(20, o));

  let dir = mkdtempSync(join(tmpdir(), "dot-soccer-"));
  try {
    const text = capture((o) => cmdMatch(join(ROOT, "data", "team_a.json"),
                                         join(ROOT, "data", "team_b.json"), 1, dir, o));
    const all = text.split("\n");
    if (all[all.length - 1] === "") all.pop();
    out.match = all.filter((l) => !l.includes("実行") && !l.startsWith("ログ:")).join("\n");
    out.match_log = JSON.parse(readFileSync(join(dir, "match_seed1.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  dir = mkdtempSync(join(tmpdir(), "dot-soccer-"));
  try {
    const lines: string[] = [];
    playGame(join(dir, "s.json"), g.play_inputs, (t) => { lines.push(t); });
    out.play_inputs = g.play_inputs;
    out.play_transcript = lines.map((l) => maskSaveDir(l, dir));
    out.play_save = JSON.parse(readFileSync(join(dir, "s.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  out.standings_fmt = formatStandings(Career.newGame("X", 1).standings(), "X");
  dump("cli", out);
}

/**
 * 特訓の正解データのうち**課題の判定だけ**を、今の線で書き直す（入力のスタッツはそのまま）。
 * 🔑 特訓の効き・タイプ判定は Python 版との照合のまま触らない。課題の線は D-51 で新エンジンに合わせて変えた規則なので、
 *    規則を変えたら作り直すものに入れる
 */
function genTrainingIssues(): void {
  const g = golden<any>("training");
  g.issues = g.issues.map((i: any) => ({ stats: i.stats, issues: findIssues(i.stats) }));
  dump("training", g);
}

console.log("正解データを書き直します:");
genTrainingIssues();
genMatches();
genBatch();
genCareer();
genCli();
