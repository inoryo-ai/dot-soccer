/**
 * ブラウザ用の入口（`src/web/api.ts`）を固定する。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここが壊れると「画面は出るのに遊べない」
 * ─────────────────────────────────────────────────────────────
 * この層は `src/sim/` の値を画面が欲しい形に並べ直すだけの薄い層だが、
 * **JSON にしたとき形が変わる値が1つ混ざるだけで、画面やセーブが黙って壊れる**。
 * Python 版では「JSON にできない値で落ちる」（frozenset・tuple の鍵など）だった。
 * TypeScript では落ちずに**黙って化ける**（Map・Set は `{}`、undefined は消える、
 * NaN は null、クラスのインスタンスは getter が消える）ので、なお気づきにくい。
 * ここで「全部の戻り値が JSON を通しても同じ値のまま」であることを数える。
 *
 * 🔑 台帳（神代）「外から来たデータを形を確かめずに渡さない」の裏返し。
 *    出す側も、出せる形になっていることを検査する。
 * 🔑 Python 版 `tests/test_web_api.py` を移したもの。`api._career = None` は `reset()` にした。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import * as api from "../src/web/api.ts";

/** JSON を通しても値が変わらないこと（変わればここで落ちる。差分がそのまま原因）。 */
function jsonOk(value: unknown): string {
  const text = JSON.stringify(value);
  assert.equal(typeof text, "string", "JSON にできない");
  assert.deepStrictEqual(JSON.parse(text), value, "JSON を通すと値が変わる");
  return text;
}

/** GameError で落ち、文面に `includes` を含むこと。 */
function throwsGameError(fn: () => unknown, includes?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof api.GameError, `GameError ではない: ${String(e)}`);
    if (includes !== undefined) assert.ok(e.message.includes(includes), e.message);
    return true;
  });
}

describe("立ち上げ", () => {
  test("bootstrap は JSON にできる", () => {
    jsonOk(api.bootstrap());
  });

  test("bootstrap に画面を組み立てるのに要るものがそろっている", () => {
    const boot = api.bootstrap();
    for (const key of ["formations", "attitudes", "cards", "default_plan",
                       "policy_conditions", "policy_actions", "pitch"]) {
      assert.ok(key in boot, `${key} が無いと画面が組み立てられない`);
    }
    assert.equal(Object.keys(boot.cards).length, 7, "カードは7枚（D-02でゾーンを追加）");
  });

  test("🔴 初期育成のおすすめ配分は必ず20回（足りないとAIだけ育った状態で開幕する）", () => {
    const boot = api.bootstrap();
    const total = Object.values(boot.default_plan).reduce((a, b) => a + b, 0);
    assert.equal(total, boot.trainings_per_player);
  });

  test("どのプリセットの配分も20回", async (t) => {
    const boot = api.bootstrap();
    for (const [name, plan] of Object.entries(boot.preset_plans)) {
      await t.test(name, () => {
        assert.equal(Object.values(plan).reduce((a, b) => a + b, 0), boot.trainings_per_player);
      });
    }
  });
});

describe("遊びの流れ", () => {
  let view: api.View;

  beforeEach(() => {
    api.reset();
    view = api.newGame("検証FC", 42, "4-4-2");
  });

  afterEach(() => {
    api.reset();
  });

  test("ゲームを始める前は、どの操作も日本語で「始まっていない」と返す", () => {
    api.reset();
    throwsGameError(() => api.view(), "ゲームが始まっていません");
  });

  test("空白だけのチーム名は弾く", () => {
    throwsGameError(() => api.newGame("   ", 1, "4-4-2"));
  });

  test("新規作成の画面データは JSON にできる", () => {
    jsonOk(view);
  });

  test("選手一覧は先発＋控えで、番号は通し番号", () => {
    const squad = view.squad;
    assert.equal(squad.filter((p) => p.starter).length, C.PLAYERS_ON_PITCH);
    assert.equal(squad.length, C.PLAYERS_ON_PITCH + C.BENCH_SIZE);
    // 番号は控えも通し番号（画面はこの番号でしか選手を指せない）
    assert.deepEqual(squad.map((p) => p.index), Array.from({ length: squad.length }, (_, i) => i));
  });

  test("次の節を消化すると再生データが付いて返り、JSON にできる", () => {
    const out = api.playNext();
    jsonOk(out);
    assert.equal(out.score.length, 2);
    assert.ok("replay" in out);
    assert.ok(out.replay.frames.length > 0);
    assert.equal(out.round, 1);
  });

  test("🔴 再生データを残すのは自チームの試合だけ（他会場まで残すと1節で約800KB増え、端末のセーブを押し出す）", () => {
    const out = api.playNext();
    assert.ok(out.others.length > 0);
    for (const other of out.others) assert.ok(!("replay" in other));
  });

  test("1シーズン通して遊び、締められる", () => {
    const rounds = view.total_rounds;
    for (let i = 0; i < rounds; i++) api.playNext();
    throwsGameError(() => api.playNext());          // 全節終了後は締めるしかない
    const closed = api.finishSeason();
    jsonOk(closed);
    assert.equal(closed.view.season, 2);
    assert.equal(closed.view.round, 0);
  });

  test("セーブして読み戻すと同じ画面になる", () => {
    api.playNext();
    const saved = JSON.parse(jsonOk(api.saveDict())) as unknown;
    const before = api.view();
    api.reset();
    const after = api.loadSave(saved);
    assert.deepEqual(before, after);
  });

  test("🔴 壊れたセーブは日本語で弾く（欠けた項目を既定値で埋めると、壊れたまま遊べてしまう）", () => {
    const saved: Record<string, unknown> = { ...api.saveDict() };
    delete saved.results;
    throwsGameError(() => api.loadSave(saved), "セーブデータを読めません");
  });

  test("特訓するとカードが1枚減り、特訓の名前が返る", () => {
    const out = api.playNext();
    assert.ok(out.awarded.length > 0, "1試合で課題が1つも出ないと特訓が始められない");
    const key = out.awarded[0]!.key;
    const before = out.view.cards[key]!;
    const trained = api.train(0, [key]);
    jsonOk(trained);
    assert.equal(trained.view.cards[key] ?? 0, before - 1);
    assert.ok(trained.label);
  });

  test("持っていないカードでの特訓は日本語で弾く", () => {
    throwsGameError(() => api.train(0, ["running"]));
  });

  test("GK とフィールド選手は入れ替えられない", () => {
    const squad = view.squad;
    const gk = squad.find((p) => p.starter && p.position === "GK")!;
    const outfieldBench = squad.find((p) => !p.starter && p.position !== "GK")!;
    throwsGameError(() => api.swapStarter(gk.index, outfieldBench.index), "GK");
  });

  test("入れ替えると本当に入れ替わる", () => {
    const squad = view.squad;
    const starter = squad.find((p) => p.starter && p.position !== "GK")!;
    const bench = squad.find((p) => !p.starter && p.position !== "GK")!;
    const after = api.swapStarter(starter.index, bench.index);
    const names = new Map(after.squad.map((p) => [p.index, p.name]));
    assert.equal(names.get(starter.index), bench.name);
    assert.equal(names.get(bench.index), starter.name);
  });

  test("未知の姿勢・フォーメーションは弾く", () => {
    throwsGameError(() => api.setTactics(3, 3, "とても攻撃的", "4-4-2"));
    throwsGameError(() => api.setTactics(3, 3, "バランス", "5-5-5"));
  });

  test("戦術の数値は黙って捨てずに範囲へ収める", () => {
    const after = api.setTactics(99, -5, "攻撃的", "3-5-2");
    assert.equal(after.tactics.line_height, 5);
    assert.equal(after.tactics.zone_width, 1);
    assert.equal(after.tactics.formation, "3-5-2");
  });

  test("🔴 未知の方針は黙って捨てずに弾く（捨てると、設定したつもりで効いていない状態になる）", () => {
    throwsGameError(() => api.setPolicy([{ condition: "ALWAYS", action: "LINE_DOWN" }]));
    throwsGameError(() => api.setPolicy([{ condition: "LEADING_LATE", action: "PARK_THE_BUS" }]));
  });

  test("方針の数には上限がある", () => {
    const boot = api.bootstrap();
    const rule = { condition: boot.policy_conditions[0]!, action: boot.policy_actions[0]! };
    throwsGameError(() => api.setPolicy(Array.from({ length: boot.policy_max_rules + 1 }, () => rule)));
  });

  test("監督のスライダーは範囲へ収める", () => {
    const after = api.setManager(9, -9, 0, 0);
    assert.equal(after.manager.style, 2);
    assert.equal(after.manager.rigidity, -2);
  });
});
