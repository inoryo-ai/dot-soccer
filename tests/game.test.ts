/**
 * ゲームとしての層（キャリア・リーグ・対話UI）の検査。
 *
 * 対話UIは `playGame` に入力を注入して**無人で最後まで歩く**。
 * 画面を一度も通さずに「遊べます」と報告しないための検査
 * （台帳: 黒瀬「自分が作った導線を、自分で最初から最後まで一度歩く」）。
 *
 * 🔑 Python 版 `tests/test_game.py` を移したもの。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import { Career, SaveError } from "../src/sim/career.ts";
import { RuntimeError, ValueError } from "../src/sim/errors.ts";
import { buildSchedule, standings } from "../src/sim/league.ts";
import type { MatchRecord } from "../src/sim/league.ts";
import {
  LEAGUE_OPPONENTS,
  PRESET_ORDER,
  TRAININGS_PER_PLAYER,
  buildPreset,
  buildUserTeam,
  expectedAbilityTotal,
} from "../src/sim/presets.ts";
import type { Plan } from "../src/sim/presets.ts";
import { CARDS } from "../src/sim/training.ts";
import { playGame } from "../src/cli/ui.ts";
import { loadCareer, saveCareer } from "../src/node/files.ts";
import { ROOT } from "./helpers.ts";

/** 一時フォルダを作って渡し、終わったら消す（Python の TemporaryDirectory）。 */
function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dot-soccer-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sumHidden = (team: { allPlayers: { hidden: Record<string, number> }[] }): number =>
  team.allPlayers.reduce((acc, p) =>
    acc + Object.values(p.hidden).reduce((s, v) => s + Math.abs(v), 0), 0);

describe("リーグ", () => {
  test("日程は全節がそろっていて、ホームとアウェーが1回ずつ", () => {
    const teams = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const sched = buildSchedule(teams, true);
    assert.equal(sched.length, 14);
    for (const rnd of sched) {
      assert.equal(rnd.length, 4);
      const played = rnd.flat();
      assert.deepEqual([...played].sort(), [...teams].sort(), "1節で全チームが1試合ずつ");
    }
    // 各組み合わせがホームとアウェーで1回ずつ
    const counts = new Map<string, number>();
    for (const rnd of sched) {
      for (const [home, away] of rnd) {
        const k = `${home}→${away}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    assert.equal(counts.size, 8 * 7, "総当たり2回戦の組み合わせ数が合わない");
    assert.deepEqual([...new Set(counts.values())], [1]);
  });

  test("チーム数が奇数なら日程を組まない", () => {
    assert.throws(() => buildSchedule(["A", "B", "C"]), ValueError);
  });

  test("順位表の並びが決定論的（勝点 → 得失点差 → 得点 → 名前）", () => {
    const teams = ["A", "B", "C", "D"];
    const results: MatchRecord[] = [
      { home: "A", away: "B", home_goals: 1, away_goals: 0 },
      { home: "C", away: "D", home_goals: 3, away_goals: 0 },
      { home: "B", away: "C", home_goals: 2, away_goals: 2 },
    ];
    const rows = standings(teams, results);
    assert.deepEqual(rows.map((r) => r.team), ["C", "A", "B", "D"]);
    assert.equal(rows[0]!.points, 4);
    // 同点・同得失点・同得点なら名前順（実装依存にしない）
    const rows2 = standings(["X", "Y"], []);
    assert.deepEqual(rows2.map((r) => r.team), ["X", "Y"]);
  });

  test("順位表に無いチームの結果は弾く", () => {
    assert.throws(() => standings(["A", "B"], [{ home: "A", away: "Z", home_goals: 0, away_goals: 0 }]),
                  ValueError);
  });
});

describe("プレイヤーとAIが同じ条件で開幕する", () => {
  test("初期育成の配分を変えても、自チームの能力合計はAIと同じ", async (t) => {
    const expected = expectedAbilityTotal();
    const plans: (Plan | null)[] = [
      null, { dash: 20 }, { pass: 10, shoot: 10 },
      { running: 4, man_mark: 4, press: 4, pass: 4, dash: 4 },
    ];
    for (const plan of plans) {
      await t.test(`plan=${JSON.stringify(plan)}`, () => {
        const team = buildUserTeam("自分", 5, "4-4-2", plan);
        assert.equal(team.abilityTotal(), expected, "初期育成の配分で能力合計が変わってはいけない");
      });
    }
    for (const name of LEAGUE_OPPONENTS) assert.equal(buildPreset(name).abilityTotal(), expected);
  });

  test("初期育成はちょうど20回でなければならない", () => {
    assert.throws(() => buildUserTeam("自分", 1, "4-4-2", { dash: 19 }), ValueError);
    assert.throws(() => buildUserTeam("自分", 1, "4-4-2", { dash: 21 }), ValueError);
    assert.equal(TRAININGS_PER_PLAYER, 20);
  });

  test("選手ごとに個性はあるが、能力合計は同じ", () => {
    const team = buildUserTeam("自分", 9);
    const field = team.allPlayers.filter((p) => p.position !== "GK");
    const sums = new Set(field.map((p) => Object.values(p.visible).reduce((a, b) => a + b, 0)));
    assert.equal(sums.size, 1, "選手ごとに能力合計が違う");
    const profiles = new Set(field.map((p) => JSON.stringify(Object.entries(p.visible).sort())));
    assert.ok(profiles.size > 1, "全選手が同じ能力＝個性が無い");
  });

  test("リーグ用に7チーム目を足しても、勝率表の前提（6チーム）は変えない", () => {
    assert.equal(PRESET_ORDER.length, 6);
    assert.equal(LEAGUE_OPPONENTS.length, 7);
    assert.deepEqual([...PRESET_ORDER], LEAGUE_OPPONENTS.slice(0, 6));
  });
});

describe("キャリア", () => {
  const fresh = (): Career => Career.newGame("わがチーム", 1);

  test("リーグは8チーム・14節", () => {
    const career = fresh();
    assert.equal(career.teams.size, 8);
    assert.equal(career.totalRounds, 14);
  });

  test("AIチームと同じ名前は付けられない", () => {
    assert.throws(() => Career.newGame("走力型", 1), ValueError);
  });

  test("1節進めるとカードがもらえて、節が進む", () => {
    const career = fresh();
    const before = career.cardTotal();
    const outcome = career.playRound();
    assert.equal(career.round_index, 1);
    assert.equal(outcome.round, 1);
    assert.equal(outcome.others.length, 3);
    assert.ok(career.cardTotal() >= before);
    for (const key of Object.keys(career.cards)) assert.ok(key in CARDS, key);
    assert.equal(career.results.length, 4, "1節で4試合が記録される");
  });

  test("全チームが同じ試合数を消化する", () => {
    const career = fresh();
    for (let i = 0; i < career.totalRounds; i++) career.playRound();
    const rows = career.standings();
    assert.deepEqual([...new Set(rows.map((r) => r.played))], [14]);
  });

  test("1シーズン通して締め、次のシーズンが始まる（AIも育つ）", () => {
    const career = fresh();
    for (let i = 0; i < career.totalRounds; i++) career.playRound();
    assert.ok(career.seasonFinished);
    const ai = career.teams.get("走力型")!;
    const beforeVisible = ai.abilityTotal();
    const beforeHidden = sumHidden(ai);
    const summary = career.finishSeason();
    assert.equal(summary.season, 1);
    assert.ok(summary.rank >= 1 && summary.rank <= 8, String(summary.rank));
    assert.equal(career.season, 2);
    assert.equal(career.round_index, 0);
    assert.deepEqual(career.results, []);
    const afterHidden = sumHidden(ai);
    assert.ok(afterHidden > beforeHidden, "AIチームがシーズンをまたいで成長していない");
    // 見える能力は既に上限100に達しているので増えない（＝これで測ってはいけない）。
    assert.equal(ai.abilityTotal(), beforeVisible);
    // 2シーズン目も普通に始まる
    career.playRound();
    assert.equal(career.round_index, 1);
  });

  test("シーズンが終わったら試合はできない", () => {
    const career = fresh();
    for (let i = 0; i < career.totalRounds; i++) career.playRound();
    assert.throws(() => career.playRound(), RuntimeError);
  });

  test("全節が終わる前にシーズンは締められない", () => {
    assert.throws(() => fresh().finishSeason(), RuntimeError);
  });

  test("特訓するとカードを使う（2枚ならスペシャル）", () => {
    const career = fresh();
    career.cards = { shoot: 2, dash: 1 };
    const result = career.trainPlayer(0, ["shoot"]);
    assert.equal(career.cards.shoot, 1);
    assert.equal(result.label, "シュート");
    assert.ok("goal_wait" in result.deltas);
    // 2枚使えばスペシャル
    const result2 = career.trainPlayer(0, ["shoot", "dash"]);
    assert.equal(result2.label, "抜け出して沈める");
    assert.ok(!("dash" in career.cards));
  });

  test("カードが無い・相反カードの特訓は弾き、カードも減らさない", () => {
    const career = fresh();
    career.cards = {};
    assert.throws(() => career.trainPlayer(0, ["shoot"]), ValueError);
    career.cards = { man_mark: 1, zone: 1 };
    assert.throws(() => career.trainPlayer(0, ["man_mark", "zone"]), ValueError);   // 相反カード
    // 弾かれたときにカードが減っていないこと
    assert.deepEqual(career.cards, { man_mark: 1, zone: 1 });
  });

  test("範囲外の選手番号は弾く", () => {
    const career = fresh();
    career.cards = { shoot: 1 };
    assert.throws(() => career.trainPlayer(99, ["shoot"]), ValueError);
  });

  test("同じセーブ・同じ節なら試合結果が再現する", () => {
    const a = Career.newGame("同じ", 777);
    const b = Career.newGame("同じ", 777);
    for (let i = 0; i < 3; i++) {
      const ra = a.playRound();
      const rb = b.playRound();
      assert.deepEqual(ra.mine.record, rb.mine.record);
      assert.deepEqual(ra.others, rb.others);
    }
    assert.deepEqual(a.cards, b.cards);
  });
});

describe("セーブ", () => {
  test("保存して読み戻すと同じ状態で、続きから同じ結果になる", () => {
    const career = Career.newGame("保存テスト", 3);
    career.playRound();
    career.cards.shoot = 4;
    const loaded = withTempDir((d) => {
      const path = join(d, "s.json");
      saveCareer(career, path);
      return loadCareer(path);
    });
    assert.equal(loaded.user_team, career.user_team);
    assert.equal(loaded.season, career.season);
    assert.equal(loaded.round_index, career.round_index);
    assert.deepEqual(loaded.cards, career.cards);
    assert.deepEqual(loaded.results, career.results);
    assert.deepEqual(loaded.toDict(), career.toDict());
    // 続きから同じ結果になる
    assert.deepEqual(loaded.playRound().mine.record, career.playRound().mine.record);
  });

  test("項目が欠けたセーブは読まない", () => {
    const d: Record<string, unknown> = { ...Career.newGame("欠損テスト", 4).toDict() };
    delete d.cards;
    assert.throws(() => Career.fromDict(d), SaveError);
  });

  test("版が違うセーブは読まない", () => {
    const d: Record<string, unknown> = { ...Career.newGame("版テスト", 4).toDict() };
    d.version = 999;
    assert.throws(() => Career.fromDict(d), SaveError);
  });

  test("未知のカードを持つセーブは読まない", () => {
    const d: Record<string, unknown> = { ...Career.newGame("札テスト", 4).toDict() };
    d.cards = { nonexistent: 1 };
    assert.throws(() => Career.fromDict(d), SaveError);
  });

  test("壊れたファイル・無いファイルは SaveError", () => {
    withTempDir((d) => {
      const path = join(d, "broken.json");
      writeFileSync(path, "{ これはJSONではない", "utf8");
      assert.throws(() => loadCareer(path), SaveError);
      assert.throws(() => loadCareer(join(d, "ない.json")), SaveError);
    });
  });

  test("書き込みは別名に出してから置き換える（途中で落ちても前のセーブが残る）", () => {
    const career = Career.newGame("原子性", 5);
    withTempDir((d) => {
      const path = join(d, "s.json");
      saveCareer(career, path);
      const first = readFileSync(path, "utf8");
      career.playRound();
      saveCareer(career, path);
      assert.notEqual(readFileSync(path, "utf8"), first);
      assert.deepEqual(readdirSync(d).filter((f) => f.endsWith(".tmp")), [], "一時ファイルが残っている");
    });
  });
});

describe("対話画面（入力を注入して歩く）", () => {
  function run(inputs: string[], save: string): string {
    const lines: string[] = [];
    const code = playGame(save, inputs, (text) => { lines.push(text); });
    assert.equal(code, 0);
    return lines.join("\n");
  }

  test("新規作成 → 全14節 → シーズン終了 → 順位表 → セーブ", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      const inputs = ["歩きテスト", "11", "1", "6"];
      for (let i = 0; i < 14; i++) inputs.push("1", "1", "");   // 全14節
      inputs.push("1", "");                                       // シーズンを締める
      inputs.push("4", "");                                       // 順位表（過去成績の表示）
      inputs.push("0");                                           // セーブしてやめる
      const out = run(inputs, save);
      assert.ok(out.includes("第14節"));
      assert.ok(out.includes("1シーズン目 終了"));
      assert.ok(out.includes("過去の成績: 1季"));
      assert.ok(out.includes("💾 セーブしました"));
      const career = loadCareer(save);
      assert.equal(career.season, 2);
      assert.equal(career.round_index, 0);
    });
  });

  test("特訓画面で選手が変わる", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      const inputs = ["特訓テスト", "12", "1", "6",
                      "1", "1", "",                   // 1試合してカードを得る
                      "2", "1", "0", "1", "1",        // 特訓（#0・1枚目・通常）
                      "0", "0"];
      const out = run(inputs, save);
      assert.ok(out.includes("特訓カードを獲得"));
      assert.ok(out.includes("▷"));
      assert.ok(out.includes("タイプが変わった") || out.includes("変化なし"));
    });
  });

  test("戦術・方針・フォーメーションの変更がセーブに残る", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      const inputs = ["戦術テスト", "13", "1", "6",
                      "3",                            // 戦術
                      "2", "5", "2", "3",             // ライン5・幅2・姿勢=攻撃的
                      "3", "1", "1", "1", "0",        // 方針: LEADING_LATE → LINE_DOWN
                      "1", "4",                       // フォーメーション 3-4-3
                      "0",                            // 戻る
                      "0"];
      run(inputs, save);
      const career = loadCareer(save);
      assert.equal(career.me.tactics.line_height, 5);
      assert.equal(career.me.tactics.zone_width, 2);
      assert.equal(career.me.tactics.attitude, "攻撃的");
      assert.equal(career.me.tactics.formation, "3-4-3");
      assert.equal(career.me.policy.length, 1);
      assert.equal(career.me.policy[0]!.condition, "LEADING_LATE");
      assert.equal(career.me.policy[0]!.action, "LINE_DOWN");
    });
  });

  test("セーブの続きから遊べる", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      run(["続きテスト", "14", "1", "6", "1", "1", "", "0"], save);
      const out = run(["1", "0"], save);          // 1) 続きから遊ぶ
      assert.ok(out.includes("第2節から"));
    });
  });

  test("おかしな入力でも落ちない", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      const out = run(["壊しテスト", "abc", "-5", "999999999", "7", "1",
                       "9",                       // 自分で配分する
                       "20",                      // ランニングに20回（残り0）
                       "zzz", "9", "0"], save);
      assert.ok(out.includes("⚠"));
      const career = loadCareer(save);
      assert.equal(career.me.abilityTotal(), expectedAbilityTotal());
    });
  });

  test("入力が尽きても落ちずにセーブして終わる", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      const out = run(["EOFテスト", "15", "1", "6"], save);
      assert.ok(out.includes("入力が終了しました"));
      assert.ok(existsSync(save));
    });
  });

  test("自分で決めた初期育成の配分でも能力合計は変わらない", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      run(["配分テスト", "16", "1", "9", "0", "0", "0", "10", "5", "3", "0"], save);
      const career = loadCareer(save);
      assert.equal(career.me.abilityTotal(), expectedAbilityTotal());
    });
  });

  test("先発と控えを入れ替えられる", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      const before = Career.newGame("交代テスト", 17);
      const namesBefore = before.me.players.map((p) => p.name);
      run(["交代テスト", "17", "1", "6",
           "2", "2", "1", "12",            // 先発#1(DF) と 控えのDF(#12)
           "0", "0"], save);
      const career = loadCareer(save);
      const namesAfter = career.me.players.map((p) => p.name);
      assert.notDeepEqual(namesBefore, namesAfter);
      assert.equal(career.me.players.length, C.PLAYERS_ON_PITCH);
      assert.equal(career.me.players.filter((p) => p.position === "GK").length, 1);
    });
  });

  test("GKを外すときは、控えのGKだけが候補に出る（不一致を踏ませない）", () => {
    withTempDir((d) => {
      const save = join(d, "s.json");
      const out = run(["GKテスト", "18", "1", "6",
                       "2", "2", "0", "11",       // GK(#0) ⇄ 控えのGK(#11)
                       "0", "0"], save);
      const career = loadCareer(save);
      assert.equal(career.me.players.filter((p) => p.position === "GK").length, 1);
      assert.ok(out.includes("入れ替えられる控え"));
      // 候補にフィールド選手が混ざっていないこと
      const listed = out.split(/\r?\n/).filter((ln) => {
        const s = ln.trim();
        return s.startsWith("11)") || s.startsWith("12)");
      });
      assert.ok(listed.length > 0);
      assert.ok(listed.every((ln) => ln.includes("GK")), JSON.stringify(listed));
    });
  });
});

describe("文字コード", () => {
  test("パイプで渡した日本語のチーム名が文字化けせずに保存される", () => {
    // 🔴 出力だけ UTF-8 にして入力を忘れると、日本語のチーム名が文字化けする。
    //    実測（Python 版）: パイプで渡した「フェニックス」が「繝輔ぉ繝九ャ繧ｯ繧ｹ」として保存された。
    // 🔑 Python 版は `force_utf8_io()` が標準入出力を UTF-8 に切り替えたかを見ていた。
    //    Node 版には切り替える関数が無い（標準入力をバイトで読んで UTF-8 として解く）ので、
    //    実際にコマンドを起動してパイプで名前を渡し、セーブに残った名前を確かめる。
    withTempDir((d) => {
      const save = join(d, "s.json");
      const r = spawnSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), "play",
                                             "--save", save], {
        input: Buffer.from(["フェニックス", "15", "1", "6", ""].join("\n"), "utf8"),
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes("入力が終了しました"), r.stdout.slice(-500));
      assert.equal(loadCareer(save).user_team, "フェニックス");
    });
  });
});
