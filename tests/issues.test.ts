/**
 * 育成の課題（＝もらえる特訓カード）が、ゲームの試合で**どれも出る**ことを固定する（D-51）。
 *
 * 🔴 2026-10-05: 試合を新エンジンに替えたら、旧エンジンの出力で決めていた課題の線のままでは
 *    ランニング・マンツーマン・ダッシュ・パス の4枚が**一度も出なかった**。例外は出ず、試合も育成も回るので、
 *    「その能力を育てる手段が消えた」ことに気づけない。エンジンを替えたら、そのエンジンの出力で決めていた線は
 *    全部古くなる。ここで、どのカードも出る（出すぎない）ことを確かめる。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { combinations } from "../src/sim/batch.ts";
import { playNew } from "../src/sim/match/game.ts";
import { PRESET_ORDER, buildPreset } from "../src/sim/presets.ts";
import { CARDS, findIssues } from "../src/sim/training.ts";

/** 課題から出るカード（`training.ts` の `findIssues` が見る7つ） */
const ISSUE_KEYS: Record<string, true> = {
  running: true, man_mark: true, press: true, pass: true, dash: true, shoot: true, zone: true,
};

describe("🔴 育成の課題はどれも出る（エンジンを替えたら線が古くなる・D-51）", () => {
  const counts = new Map<string, number>();
  let n = 0;
  for (const [h, a] of combinations([...PRESET_ORDER])) {
    const r = playNew(buildPreset(h), buildPreset(a), 4242, false, false);
    for (const is of r.issues) {
      n += 1;
      for (const k of is) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  // 課題から出るカード＝findIssues が返しうる鍵（特訓カードのうち課題に結びつくもの）
  const keys = Object.keys(ISSUE_KEYS);

  test("どの課題も少なくとも1回は出る", () => {
    for (const k of Object.keys(ISSUE_KEYS)) {
      assert.ok((counts.get(k) ?? 0) > 0, `課題「${k}」が プリセット総当たり ${n}チーム試合で一度も出ない（線が古い）`);
    }
  });

  test("どの課題も出すぎない（毎試合出るなら、課題として何も言っていない）", () => {
    for (const k of keys) {
      const rate = (counts.get(k) ?? 0) / n;
      assert.ok(rate < 0.8, `課題「${k}」が ${(100 * rate).toFixed(0)}% の試合で出る`);
    }
  });

  test("findIssues が返す鍵はどれも特訓カード", () => {
    for (const k of counts.keys()) assert.ok(k in CARDS, `未知のカード: ${k}`);
    assert.ok(findIssues({}).every((k) => k in CARDS));
  });
});

