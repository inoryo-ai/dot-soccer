/**
 * 試合シミュレーターの検査（要件定義書 §11 のテスト項目＋実装中に踏んだ不具合の回帰）。
 *
 * 🔑 Python 版 `tests/test_sim.py` を移したもの。`node --test tests/sim.test.ts` で回る。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import { buildJobs, summarize } from "../src/sim/batch.ts";
import type { JobResult } from "../src/sim/batch.ts";
import { Match, play, seedFor } from "../src/sim/engine.ts";
import { ValueError } from "../src/sim/errors.ts";
import { FORMATIONS, Player, Tactics, effectiveSlots, judgeType } from "../src/sim/model.ts";
import type { Hidden, PlayerData } from "../src/sim/model.ts";
import {
  PRESET_ORDER,
  abilityTotals,
  buildPreset,
  checkNoClamping,
  expectedAbilityTotal,
} from "../src/sim/presets.ts";
import {
  CARDS,
  CARD_KEYS,
  FORBIDDEN_PAIRS,
  SPECIAL_NAMES,
  applyTraining,
  findIssues,
  pairKey,
  specialName,
} from "../src/sim/training.ts";
import { loadTeam } from "../src/node/files.ts";
import { ROOT } from "./helpers.ts";

function freshPlayer(kw: Partial<PlayerData> = {}): Player {
  return new Player({
    name: "検証くん", position: "MF",
    kick: 40, speed: 40, stamina: 40, technique: 40, physical: 40,
    ...kw,
  });
}

/** Python の assertAlmostEqual(places=n)（差を n 桁に丸めて 0 か）。 */
function assertAlmostEqual(a: number, b: number, places = 7, msg?: string): void {
  assert.ok(Math.abs(a - b) < 0.5 * 10 ** -places, msg ?? `${a} ≉ ${b}`);
}

/** コメントを除いたソースの行（「使っていない」の検査がコメントの説明に反応しないように）。 */
function codeLines(path: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open >= 0) {
      line = line.slice(0, open);
      inBlock = true;
    }
    out.push(line.replace(/\/\/.*$/, ""));
  }
  return out;
}

const SIM_DIR = join(ROOT, "src", "sim");
const simFiles = (): string[] => readdirSync(SIM_DIR).filter((f) => f.endsWith(".ts")).sort();

describe("同じシードなら必ず同じ結果（要件定義書 §6）", () => {
  test("同じシードで2回回すと、スコア・スタッツ・課題・経過がすべて同じ", () => {
    const a = buildPreset("走力型");
    const b = buildPreset("堅守型");
    const r1 = play(a.clone(), b.clone(), 42, true);
    const r2 = play(a.clone(), b.clone(), 42, true);
    assert.deepEqual(r1.score, r2.score);
    assert.deepEqual(r1.stats, r2.stats);
    assert.deepEqual(r1.issues, r2.issues);
    assert.equal(r1.events.length, r2.events.length);
    assert.deepEqual(r1.events, r2.events);
  });

  test("シードを変えると結果が変わる（床の検査: 何を渡しても同じなら『再現性あり』は意味を持たない）", () => {
    const a = buildPreset("走力型");
    const b = buildPreset("堅守型");
    const scores = new Set<string>();
    for (let s = 1; s <= 12; s++) {
      scores.add(play(a.clone(), b.clone(), s, false).score.join("-"));
    }
    assert.ok(scores.size > 1, "シードを変えても結果が1通りしかない");
  });

  test("種を渡せない乱数（Math.random 等）を使っていない（D-08）", () => {
    // 🔑 Python 版は `random.random(` 等のモジュール関数を探していた。
    //    TypeScript では Math.random と crypto の乱数がそれに当たる（どちらも種を渡せない）
    const offenders: string[] = [];
    for (const f of simFiles()) {
      const code = codeLines(join(SIM_DIR, f)).join("\n");
      for (const bad of ["Math.random(", "getRandomValues(", "randomInt(", "randomUUID("]) {
        if (code.includes(bad)) offenders.push(`${f}: ${bad}`);
      }
    }
    assert.deepEqual(offenders, [], `種を渡せない乱数を使っている: ${offenders.join(", ")}`);
  });

  test("三角関数・指数関数・hypot に Math のものを使っていない（JS エンジンごとに最後のビットが違う）", () => {
    // 🔴 Math.sin などは環境ごとに最後のビットが違い、同じシードでも試合が別物になる。
    // 🔑 detmath.ts は代わりの実装そのもの（試合中に起きない無限大の場合だけ Math.atan2 に任せる）
    const offenders: string[] = [];
    const bad = /Math\.(sin|cos|tan|atan|atan2|exp|hypot)\s*\(/;
    for (const f of simFiles()) {
      if (f === "detmath.ts") continue;
      codeLines(join(SIM_DIR, f)).forEach((line, i) => {
        if (bad.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `Math の三角関数等を使っている: ${offenders.join("\n")}`);
  });

  test("バッチのシードは実行順に依存せず、重複しない", () => {
    const jobs = buildJobs(4, 7);
    assert.equal(jobs.length, 4 * ((6 * 5) / 2));
    const seeds = jobs.map((j) => j[3]);
    assert.equal(new Set(seeds).size, seeds.length, "バッチのシードが重複している");
    assert.equal(seedFor(7, 3, 2, false), seedFor(7, 3, 2, false));
    assert.notEqual(seedFor(7, 3, 2, false), seedFor(7, 3, 2, true));
  });
});

describe("試合が必ず90分で終わる（要件定義書 §11）", () => {
  test("どのシードでも5,400ティック", () => {
    const a = buildPreset("プレス型");
    const b = buildPreset("パス型");
    for (const seed of [1, 2, 3, 99, 12345]) {
      const r = play(a.clone(), b.clone(), seed, false);
      assert.equal(r.ticks, C.TICKS_PER_MATCH);
      assert.equal(C.TICKS_PER_MATCH, 5400);
    }
  });

  test("保持時間の合計が試合時間を超えない", () => {
    const r = play(buildPreset("プレス型"), buildPreset("パス型"), 5, false);
    const total = r.stats.reduce((acc, s) => acc + s.possession_ticks, 0);
    assert.ok(total <= C.TICKS_PER_MATCH);
  });

  test("交代は3人まで（控え5人・§10）", () => {
    const a = buildPreset("プレス型");
    a.manager.substitution = 2;
    const m = new Match(a, buildPreset("堅守型"), 3, true);
    m.run();
    for (const ts of m.teams) assert.ok(ts.subs_used <= C.MAX_SUBSTITUTIONS);
    const subs = m.events.filter((e) => e.type === "交代");
    assert.ok(subs.length <= C.MAX_SUBSTITUTIONS * 2);
  });
});

describe("各カード20回以内にタイプが1回は変わる（要件定義書 §11＋D-03）", () => {
  test("どのカードも3〜10回目でタイプが変わる", async (t) => {
    for (const [key, card] of Object.entries(CARDS)) {
      await t.test(card.label, () => {
        const p = freshPlayer();
        const start = p.typeName;
        let changedAt: number | null = null;
        for (let i = 1; i <= 20; i++) {
          applyTraining(p, [key]);
          if (p.typeName !== start) {
            changedAt = i;
            break;
          }
        }
        assert.notEqual(changedAt, null, `${card.label} は20回でタイプが変わらない`);
        assert.ok(changedAt! <= 10, `${card.label} の変化が ${changedAt}回目（目標3〜10回）`);
        assert.ok(changedAt! >= 3, `${card.label} の変化が ${changedAt}回目（目標3〜10回）`);
      });
    }
  });

  test("スペシャルでも20回以内にタイプが変わる", async (t) => {
    for (const pair of SPECIAL_NAMES.keys()) {
      if (FORBIDDEN_PAIRS.has(pair)) continue;
      const [a, b] = pair.split("+").sort() as [string, string];
      await t.test(`${a}+${b}`, () => {
        const p = freshPlayer();
        const start = p.typeName;
        let changed = false;
        for (let i = 0; i < 20; i++) {
          applyTraining(p, [a, b]);
          if (p.typeName !== start) {
            changed = true;
            break;
          }
        }
        assert.ok(changed, `スペシャル ${a}+${b} でタイプが変わらない`);
      });
    }
  });

  test("マンツーマン＋ゾーンは打ち消し合うので禁止（D-02）", () => {
    assert.throws(() => specialName("man_mark", "zone"), ValueError);
    assert.throws(() => applyTraining(freshPlayer(), ["man_mark", "zone"]), ValueError);
  });

  test("7枚の組み合わせ21種すべてに名前がある（相反の1組を除く・D-06）", () => {
    const keys = [...CARD_KEYS];
    const allPairs = new Set<string>();
    keys.forEach((a, i) => { for (const b of keys.slice(i + 1)) allPairs.add(pairKey(a, b)); });
    assert.equal(allPairs.size, 21);
    // 相反する組（D-02）は名前を持たない。名前の表に「NG」のような番人値は置かない。
    const expected = [...allPairs].filter((p) => !FORBIDDEN_PAIRS.has(p)).sort();
    assert.deepEqual([...SPECIAL_NAMES.keys()].sort(), expected);
    assert.equal(SPECIAL_NAMES.size, 20);
    assert.equal(new Set(SPECIAL_NAMES.values()).size, 20, "スペシャル名が重複している");
  });

  test("D-01/D-02 で新設・救済したタイプに到達できる", () => {
    const reached = new Set<string>();
    for (const key of CARD_KEYS) {
      const p = freshPlayer();
      for (let i = 0; i < 20; i++) {
        applyTraining(p, [key]);
        reached.add(p.typeName);
      }
    }
    for (const t of ["ダイナモ", "プレッサー", "レジスタ", "アタッカー", "ストライカー",
                     "マンマーカー", "スイーパー"]) {
      assert.ok(reached.has(t), `${t} に到達できない`);
    }
  });
});

describe("能力・隠しパラメーターが上限を超えない（要件定義書 §11）", () => {
  test("200回特訓しても見える能力・隠しパラメーターが上下限に収まる", () => {
    for (const key of CARD_KEYS) {
      const p = freshPlayer();
      for (let i = 0; i < 200; i++) applyTraining(p, [key]);
      for (const [k, v] of Object.entries(p.visible)) {
        assert.ok(v <= C.ABILITY_MAX, `${key}: ${k}=${v}`);
        assert.ok(v >= C.ABILITY_MIN);
      }
      for (const [k, v] of Object.entries(p.hidden)) {
        assert.ok(v <= C.HIDDEN_MAX, `${key}: ${k}=${v}`);
        assert.ok(v >= (k === "zone_man" ? C.ZONE_MAN_MIN : 0));
      }
    }
  });

  test("ゾーンを積み続けると zone_man が下限で止まる", () => {
    const p = freshPlayer();
    for (let i = 0; i < 200; i++) applyTraining(p, ["zone"]);
    assert.equal(p.zone_man, C.ZONE_MAN_MIN);
  });

  test("スペシャルの1.5倍は小数切り捨て。負の値も絶対値で切り捨てる", () => {
    const p = freshPlayer();
    const r = applyTraining(p, ["running", "shoot"]);
    // stamina +3 → floor(4.5)=4, kick +3 → 4, overlap +2 → 3, goal_wait +2 → 3
    assert.equal(r.deltas.stamina, 4);
    assert.equal(r.deltas.kick, 4);
    assert.equal(r.deltas.overlap, 3);
    assert.equal(r.deltas.goal_wait, 3);
    const p2 = freshPlayer();
    const r2 = applyTraining(p2, ["zone", "shoot"]);
    assert.equal(r2.deltas.zone_man, -6);   // floor(|-4|*1.5) に符号を戻す
  });
});

describe("タイプ判定（要件定義書 §7 ＋ D-04 同値時の順位）", () => {
  const hidden = (kw: Partial<Hidden> = {}): Hidden => ({
    zone_man: 0, press: 10, support: 10, overlap: 10, run_space: 10, goal_wait: 10, ...kw,
  });

  test("初期値はバランス", () => {
    assert.equal(judgeType(hidden()), "バランス");
  });

  test("初期値が並んでいる状態では、攻撃タイプ判定に入らない（D-04）", () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(judgeType(hidden({ support: 20, overlap: 20, run_space: 20, goal_wait: 20 })),
                   "バランス");
    }
  });

  test("ストライカーには2番目との差が要る", () => {
    assert.equal(judgeType(hidden({ goal_wait: 26, run_space: 10 })), "ストライカー");
    // 2番目との差が15未満ならストライカーにはならない
    assert.notEqual(judgeType(hidden({ goal_wait: 26, run_space: 20 })), "ストライカー");
  });

  test("ストッパーとマンマーカーは press で分かれる", () => {
    assert.equal(judgeType(hidden({ zone_man: 40, press: 60 })), "ストッパー");
    assert.equal(judgeType(hidden({ zone_man: 40, press: 10 })), "マンマーカー");
  });

  test("スイーパー", () => {
    assert.equal(judgeType(hidden({ zone_man: -40, press: 10 })), "スイーパー");
  });

  test("タイプは保存しない。隠しパラメーターを動かしたら即追従する（D-07）", () => {
    const p = freshPlayer();
    assert.equal(p.typeName, "バランス");
    p.zone_man = 40;
    assert.equal(p.typeName, "マンマーカー");
    assert.ok(!("type" in p.toDict()));
  });

  test("保存データに type が書かれていたら読まない", () => {
    const d: Record<string, unknown> = { ...freshPlayer().toDict() };
    d.type = "ストライカー";
    assert.throws(() => Player.fromDict(d), ValueError);
  });
});

describe("課題（要件定義書 §8: 1試合で同じもの1回まで、最大8枚）", () => {
  test("最悪のスタッツでも8枚まで・重複なし・すべて実在のカード", () => {
    const worst = {
      stamina_low_players: 5, duels: 100, duels_lost: 100,
      tackles_won: 0, passes: 100, passes_completed: 0,
      beaten_behind: 9999, shots: 100, goals: 0, shots_against: 9999,
    };
    const issues = findIssues(worst);
    assert.ok(issues.length <= C.TRAINING_MAX_CARDS_PER_MATCH);
    assert.equal(issues.length, new Set(issues).size);
    for (const key of issues) assert.ok(key in CARDS, key);
  });

  test("完璧なスタッツなら課題は出ない", () => {
    const perfect = {
      stamina_low_players: 0, duels: 100, duels_lost: 0,
      tackles_won: 9999, passes: 100, passes_completed: 100,
      beaten_behind: 0, shots: 100, goals: 100, shots_against: 0,
    };
    assert.deepEqual(findIssues(perfect), []);
  });

  test("試行が少ないときに率で判定しない（0/1 で『成功率0%』にしない）", () => {
    const tiny = {
      stamina_low_players: 0, duels: 1, duels_lost: 1,
      tackles_won: 9999, passes: 1, passes_completed: 0,
      beaten_behind: 0, shots: 1, goals: 0, shots_against: 0,
    };
    assert.deepEqual(findIssues(tiny), []);
  });

  test("実際の試合で出た課題はすべて実在のカード", () => {
    const r = play(buildPreset("走力型"), buildPreset("パス型"), 11, false);
    for (const teamIssues of r.issues) {
      for (const key of teamIssues) assert.ok(key in CARDS, key);
    }
  });
});

describe("プリセット（要件定義書 §11「能力合計はほぼそろえる」）", () => {
  test("能力合計が全チームでそろっている", () => {
    const totals = abilityTotals();
    const values = new Set(Object.values(totals));
    assert.equal(values.size, 1, `能力合計がそろっていない: ${JSON.stringify(totals)}`);
    assert.deepEqual([...values], [expectedAbilityTotal()]);
  });

  test("上限100で切られていない", () => {
    assert.deepEqual(checkNoClamping(), []);
  });

  test("6チームのタイプ構成がばらけている", () => {
    assert.equal(PRESET_ORDER.length, 6);
    const typeSets: Record<string, string[]> = {};
    for (const name of PRESET_ORDER) {
      const t = buildPreset(name);
      typeSets[name] = [...new Set(t.players.filter((p) => p.position !== "GK")
        .map((p) => p.typeName))].sort();
    }
    // 6チームが全部同じタイプ構成なら「特訓で差が出る」が成立していない
    const distinct = new Set(Object.values(typeSets).map((v) => JSON.stringify(v)));
    assert.ok(distinct.size > 4, JSON.stringify(typeSets));
  });

  test("data/*.json が読めて、タイプが書かれていない（D-07）", async (t) => {
    const dataDir = join(ROOT, "data");
    const files = readdirSync(dataDir).filter((f) => f.endsWith(".json")).sort();
    assert.ok(files.length > 0, "data/*.json が1つも無い");
    for (const f of files) {
      await t.test(f, () => {
        const path = join(dataDir, f);
        const team = loadTeam(path);
        assert.equal(team.players.length, C.PLAYERS_ON_PITCH);
        const raw = JSON.parse(readFileSync(path, "utf8")) as
          { players: Record<string, unknown>[]; bench?: Record<string, unknown>[] };
        for (const p of [...raw.players, ...(raw.bench ?? [])]) {
          assert.ok(!("type" in p), "JSONにタイプを書いてはいけない（D-07）");
        }
      });
    }
  });
});

describe("実装中に実際に踏んだ不具合を固定する", () => {
  test("寄せの間合いが奪い合いの距離より外側にある", () => {
    // 寄せの間合いが奪い合いの距離より内側だと、全員が毎秒奪い合いに参加する。
    // 実測: 1.6m にしていたとき、1試合の奪い合いが 4,081回になった（現実は数十回規模）。
    assert.ok(C.PRESS_STANDOFF_M > C.TACKLE_RADIUS_M);
  });

  test("最終ラインは自ゴール側の選手（最前線と取り違えない）", () => {
    // 最終ラインを最前線と取り違えると、裏抜け型が機能しない（実測シュート1.1本）。
    const m = new Match(buildPreset("裏抜け型"), buildPreset("堅守型"), 1, false);
    const mm = m as any;
    mm.resetPositions(0);
    for (const ts of m.teams) {
      const last: number = mm.lastDefenderX(ts);
      const fieldXs = m.actors[ts.idx]!.filter((a) => a.pos !== "GK").map((a) => a.x);
      const ownGoal = ts.ownGoalX();
      const nearest = fieldXs.reduce((best, x) =>
        (Math.abs(x - ownGoal) < Math.abs(best - ownGoal) ? x : best));
      assertAlmostEqual(last, nearest, 6);
    }
  });

  test("run_space の選手はオフサイドラインを越えない（オフサイドが現実的な回数に収まる）", () => {
    // run_space は相手最終ラインの手前まで。越えるとオフサイドで得点が壊れる。
    // 実測: 越える実装のとき裏抜け型が1試合平均6.6得点だった。
    const m = new Match(buildPreset("裏抜け型"), buildPreset("堅守型"), 2, false);
    m.run();
    // 反則として数えられた回数が現実的な範囲に収まっていること（床と天井）
    const offsides = ((m as any).result().stats as { offsides: number }[]).map((s) => s.offsides);
    assert.ok(Math.max(...offsides) <= 60, `オフサイドが多すぎる: ${offsides}`);
  });

  test("行動に時間がかかる（1ティックごとに判断させない）", () => {
    // 1ティックごとに判断させると、パス数・奪い合い数が現実離れする。
    assert.ok(C.ACTION_CONTROL_TICKS >= 1);
    assert.ok(C.TACKLE_COOLDOWN_TICKS >= 1);
    const r = play(buildPreset("バランス型"), buildPreset("堅守型"), 4, false);
    for (const s of r.stats) {
      assert.ok(s.passes < 1200, "パス数が現実離れしている");
      assert.ok(s.duels < 2500, "奪い合いが現実離れしている");
    }
  });

  test("両チームのスタッツが鏡になっている（シュート⇔被シュート、得点⇔スコア）", () => {
    const r = play(buildPreset("走力型"), buildPreset("プレス型"), 6, false);
    const [a, b] = r.stats as [typeof r.stats[0], typeof r.stats[0]];
    assert.equal(a.shots, b.shots_against);
    assert.equal(b.shots, a.shots_against);
    assert.equal(a.goals, r.score[0]);
    assert.equal(b.goals, r.score[1]);
  });

  test("チーム方針が実際に発動して記録される（書いただけで動いていないのを防ぐ）", () => {
    const m = new Match(buildPreset("プレス型"), buildPreset("走力型"), 8, true);
    m.run();
    const fired = m.events.filter((e) => e.type === "方針の発動");
    assert.ok(fired.length > 0, "チーム方針が一度も発動していない");
    assert.ok(fired.every((e) => e.detail.includes("→")));
  });

  test("徹底的な監督（rigidity +2）ほど方針が発動しにくい（§10）", () => {
    const fired = (rigidity: number): number => {
      const t = buildPreset("プレス型");
      t.manager.rigidity = rigidity;
      const m = new Match(t, buildPreset("走力型"), 9, true);
      m.run();
      return m.events.filter((e) => e.type === "方針の発動" && e.team === t.name).length;
    };
    assert.ok(fired(0) > fired(2));
  });
});

describe("一括対戦の集計", () => {
  test("勝敗・得失点・全体勝率を数える", () => {
    const teams = ["A", "B"];
    const results: JobResult[] = [[0, "A", "B", 2, 1], [0, "B", "A", 0, 0], [0, "A", "B", 0, 3]];
    const s = summarize(results, teams, 3, 1);
    assert.deepEqual(s.record.A, { w: 1, d: 1, l: 1, gf: 2, ga: 4 });
    assert.deepEqual(s.record.B, { w: 1, d: 1, l: 1, gf: 4, ga: 2 });
    assertAlmostEqual(s.overall_rate.A!, 0.5);
  });

  test("上限と下限の両方で警告する（天井だけ見ると『弱すぎるチーム』を見逃す）", () => {
    const teams = ["A", "B"];
    const results: JobResult[] = Array.from({ length: 10 }, (): JobResult => [0, "A", "B", 3, 0]);
    const s = summarize(results, teams, 10, 1);
    assert.ok(s.warnings.some((w) => w.includes("上限")));
    assert.ok(s.warnings.some((w) => w.includes("下限")));
  });
});

describe("立ち位置の上書き（事務所でドラッグして動かしたもの）", () => {
  /** 全員を自陣へ下げた配置。GK は規則の上限 0.30 を超えない */
  const pullBack = (t: ReturnType<typeof buildPreset>): void => {
    const base = effectiveSlots(t.tactics);
    t.tactics.slots = base.map(([pos, x, y]) =>
      [pos === "GK" ? x : Math.max(0.05, x - 0.12), y] as const);
  };

  test("🔴 動かすと試合の結果が変わる（変わらなければ、盤の上だけで効いていない）", () => {
    const seen = new Set<string>();
    for (const shift of [false, true]) {
      const a = buildPreset("バランス型");
      if (shift) pullBack(a);
      const r = play(a, buildPreset("プレス型"), 1234, false);
      seen.add(`${r.score.join("-")}/${JSON.stringify(r.stats)}`);
    }
    assert.equal(seen.size, 2, "配置を変えても試合がまったく同じ＝上書きが効いていない");
  });

  test("上書きしても決定論は崩れない（同じ配置・同じシードなら同じ結果）", () => {
    const build = (): ReturnType<typeof buildPreset> => {
      const t = buildPreset("バランス型");
      pullBack(t);
      return t;
    };
    const r1 = play(build(), buildPreset("プレス型"), 77, true);
    const r2 = play(build(), buildPreset("プレス型"), 77, true);
    assert.deepEqual(r1.score, r2.score);
    assert.deepEqual(r1.events, r2.events);
  });

  test("上書きが無いチームは、既定の枠がそのまま出る", () => {
    const t = buildPreset("バランス型");
    assert.equal(t.tactics.slots, null);
    assert.deepEqual(effectiveSlots(t.tactics), FORMATIONS[t.tactics.formation]);
  });

  test("🔴 おかしな上書きは作った時点で弾く（黙って直さない）", () => {
    assert.throws(() => new Tactics({ formation: "4-4-2", slots: [[0.1, 0.1]] }), ValueError);
    assert.throws(() => new Tactics({
      formation: "4-4-2",
      slots: FORMATIONS["4-4-2"]!.map(([, x, y], i) => [i === 0 ? 0.9 : x, y] as const),
    }), ValueError);
  });
});
