/**
 * 型の個性が**試合の動き**に出ている（要件定義書 §6 の核・D-44）。
 *
 * 🔴 タイプが変わること（§7）は検査していたが、試合の中で動きが違うことは検査していなかった。
 *    D-43/D-44 の途中で、裏へ走る意思が全体の 0.3% まで消え、型の個性が動きに出ないまま
 *    勝率だけがそろっていた（そろったのは個性が消えたからだった）。
 *    隠しパラメーターを「選びやすさ」にする式（engine.ts の tendency）を直すときに、必ずこれが見る。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SIGNATURE, teamIntentShares } from "../scripts/diagnose_ai.ts";

const SEEDS = [11, 12];
const RATIO = 1.5;   // バランス型より、その意思を何倍以上選んでいれば「個性が出ている」とするか

test("各型は、その型らしい意思をバランス型より明らかに多く選ぶ", async (t) => {
  const base = teamIntentShares("バランス型", "バランス型", SEEDS);
  for (const [team, [intent, phase]] of Object.entries(SIGNATURE)) {
    await t.test(`${team}: ${intent}`, () => {
      const mine = teamIntentShares(team, "バランス型", SEEDS)[phase].get(intent) ?? 0;
      const ref = base[phase].get(intent) ?? 0;
      assert.ok(mine >= RATIO * ref && mine > 0.01,
                `${team} の ${intent} ${(100 * mine).toFixed(1)}% / バランス型 ${(100 * ref).toFixed(1)}%`);
    });
  }
});
