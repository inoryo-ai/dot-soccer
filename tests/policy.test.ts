/**
 * 学習する判断（D-48・`src/sim/policy.ts`）を固定する。
 *
 * 🔑 ①網の入力の数と特徴の数が合う（数え間違いで黙って違う特徴を読まない）
 *    ②同じ重み・同じシードなら同じ練習（決定論）③重みの数が違えば止まる
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { playArena } from "../src/sim/arena.ts";
import { ATTACK_INPUTS, DEFEND_INPUTS, netAttack, netDefend, netSize, score, unflatten }
  from "../src/sim/policy.ts";
import { POLICY_S1 } from "../src/sim/policy_s1.ts";
import { buildPreset } from "../src/sim/presets.ts";

const fw = buildPreset("裏抜け型").players.find((p) => p.position === "FW")!;
const df = buildPreset("堅守型").players.find((p) => p.position === "DF")!;
const gk = buildPreset("バランス型").players.find((p) => p.position === "GK")!;

const H = POLICY_S1.hidden;
const att = netAttack(unflatten([...POLICY_S1.attack], ATTACK_INPUTS, H));
const def = netDefend(unflatten([...POLICY_S1.defend], DEFEND_INPUTS, H));

describe("学習する判断", () => {
  test("学習した重みの数が網の形と合う", () => {
    assert.equal(POLICY_S1.attack.length, netSize(ATTACK_INPUTS, H));
    assert.equal(POLICY_S1.defend.length, netSize(DEFEND_INPUTS, H));
  });

  test("学習した判断で練習を回せる（特徴の数が網と合わなければ score が止める）", () => {
    const r = playArena(fw, df, gk, 3, 20, { attack: att, defend: def });
    assert.equal(r.attacks.length, 20);
  });

  test("同じ重み・同じシードなら同じ練習（決定論・D-08）", () => {
    const a = playArena(fw, df, gk, 11, 30, { attack: att, defend: def });
    const b = playArena(fw, df, gk, 11, 30, { attack: att, defend: def });
    assert.deepEqual(a.replay.frames, b.replay.frames);
  });

  test("重みの数が違えば止まる・特徴の数が違えば止まる", () => {
    assert.throws(() => unflatten([1, 2, 3], ATTACK_INPUTS, H));
    const net = unflatten(new Array<number>(netSize(2, 1)).fill(0), 2, 1);
    assert.throws(() => score(net, [1, 2, 3]));
  });
});
