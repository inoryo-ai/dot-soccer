/**
 * 実測値の判定（`scripts/measure.ts`）を固定する。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここが壊れると「桁で狂った値が緑のまま通る」
 * ─────────────────────────────────────────────────────────────
 * ループ#1で「1試合の奪い合い4,081回・走行191km」が出たが、例外も出ず試合も
 * 成立していたので、人が表を見るまで分からなかった。期待レンジはその再発を
 * 機械で止めるために置いた。**その判定自体が正しく赤くなることを、ここで確かめる。**
 *
 * 🔴 台帳「検査を足したら、必ず故障を注入して赤くなることを確かめる」[4回・機械化済み]。
 *    緑は「壊れていない」証拠にならないので、**わざと外した値を通して赤を見る**。
 *
 * 🔑 判定は2段構え（2026-10-01・ループ#5で作り直し）。
 *    相場は**リーグの平均**なので、1チームずつではなく**平均**と比べる。
 *    そのかわり「どのチームも壊れていないか」を別に見る。
 *    片方だけだと、平均を合わせて中身がめちゃくちゃでも緑になる。
 *
 * 🔑 Python 版 `tests/test_measure.py` を移したもの。
 *    Python 版は `measure.KNOWN_RED` を差し替えていたが、ES モジュールの export は
 *    外から差し替えられないので、同じ Set の中身を入れ替えて、終わったら戻す。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import * as measure from "../scripts/measure.ts";
import type { Rows } from "../scripts/measure.ts";

// 🔑 すべて相場の内側にある1チーム分。ここから1項目だけ外して故障を注入する
const INSIDE: Record<string, number> = {
  goals: 1.4,
  shots: 13.5,
  conversion_pct: 10.3,
  distance_km: 102.0,
  possession_pct: 50.0,
};

/** 1チームだけの実測表を作る。指定した項目だけ差し替える。 */
function rows(overrides: Record<string, number> = {}): Rows {
  return { 検証チーム: { ...INSIDE, ...overrides } };
}

function team(name: string, overrides: Record<string, number> = {}): Rows {
  return { [name]: { ...INSIDE, ...overrides } };
}

const knownRed = measure.KNOWN_RED as Set<string>;

/** 既知の赤をこの中身にする（Python 版の `measure.KNOWN_RED = frozenset(...)`）。 */
function setKnownRed(keys: string[]): void {
  knownRed.clear();
  for (const k of keys) knownRed.add(k);
}

describe("期待レンジ", () => {
  test("🔴 どの期待レンジにも出典がある（推測を基準にしない）", () => {
    for (const [key, exp] of Object.entries(measure.EXPECTED)) {
      assert.ok(exp.source.trim(), `${key} に出典が無い`);
      assert.ok(exp.low < exp.high, `${key} の上下が逆`);
    }
  });

  test("KNOWN_RED に書かれているのは実在の指標だけ", () => {
    for (const key of measure.KNOWN_RED) {
      assert.ok(key in measure.EXPECTED, `KNOWN_RED の ${key} は期待レンジに無い`);
    }
  });

  test("表に出す指標にはすべて表示名がある", () => {
    for (const key of [...Object.keys(measure.EXPECTED), ...measure.WATCH_ONLY]) {
      assert.ok(key in measure.LABELS, `${key} の表示名が無い`);
    }
  });

  test("🔴 KNOWN_RED は空（バランス調整のループの終了条件。増やすなら報告書に理由を書く）", () => {
    assert.deepEqual([...measure.KNOWN_RED], [],
                     "既知の赤が復活している（報告書に理由があるか確かめる）");
  });
});

describe("🔴 相場はリーグの平均。1チームずつ比べない", () => {
  let saved: string[] = [];

  beforeEach(() => {
    saved = [...knownRed];
  });

  afterEach(() => {
    setKnownRed(saved);
  });

  test("全部が相場の内側なら何も止めない", () => {
    setKnownRed([]);
    const [blocking, stillRed] = measure.judge(rows());
    assert.deepEqual(blocking, []);
    assert.deepEqual(stillRed, []);
  });

  test("チームごとに幅があっても、平均が相場内なら通す", () => {
    // 1種類だけ20回積んだチームと実在リーグの平均を直接比べるのは、
    // 測り方のほうが間違っている（ループ#5で作り直した理由）。
    setKnownRed([]);
    const table = { ...team("撃つ型", { goals: 1.85 }), ...team("守る型", { goals: 1.05 }) };
    const [blocking] = measure.judge(table);
    assert.deepEqual(blocking, [], `平均 1.45 は相場内なのに止めている: ${blocking}`);
  });

  test("平均が相場を外れたら止める", async (t) => {
    setKnownRed([]);
    const cases: [string, number][] = [
      ["goals", 0.2], ["shots", 40.0], ["conversion_pct", 1.0],
      ["distance_km", 60.0], ["possession_pct", 99.0],
    ];
    for (const [key, bad] of cases) {
      await t.test(key, () => {
        const [blocking] = measure.judge(rows({ [key]: bad }));
        assert.ok(blocking.length > 0, `${key}=${bad} が素通りした`);
      });
    }
  });

  test("🔴 平均が合っていても、壊れたチームがいれば止める（平均だけ見ると中身がめちゃくちゃでも緑になる）", () => {
    // 相場の幅1つぶん外れたチームは、平均が合っていても壊れている。
    setKnownRed([]);
    // 得点の相場は 1.0〜1.9（幅0.9）。片方を 3.0、もう片方を 0.0 にすると
    // 平均 1.5 は相場内だが、両方とも幅1つぶん外れている
    const table = { ...team("壊れた型", { goals: 3.0 }), ...team("沈黙型", { goals: 0.0 }) };
    const [blocking] = measure.judge(table);
    assert.ok(blocking.length > 0, "平均だけ合っていれば通してしまう");
    assert.ok(blocking.some((b) => b.includes("壊れている")), JSON.stringify(blocking));
  });

  test("既知の赤は止めない（既知の赤のままとして報告する）", () => {
    setKnownRed(["goals"]);
    const [blocking, stillRed] = measure.judge(rows({ goals: 0.2 }));
    assert.deepEqual(blocking.filter((b) => b.includes("平均が新しく外れた")), []);
    assert.equal(stillRed.length, 1);
  });

  test("🔴 相場に戻ったのに KNOWN_RED に残っていたら止める（消さずに放置すると、次に同じ指標が外れても見逃す）", () => {
    setKnownRed(["goals"]);
    const [blocking, stillRed] = measure.judge(rows());
    assert.deepEqual(stillRed, []);
    assert.ok(blocking.some((b) => b.includes("KNOWN_RED から goals を消すこと")),
              JSON.stringify(blocking));
  });
});
