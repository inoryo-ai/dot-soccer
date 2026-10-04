/**
 * キックオフの立ち位置と、ゴール後の再開を固定する。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここが壊れると「ルールを知っている人が見ればすぐおかしい試合」に戻る
 * ─────────────────────────────────────────────────────────────
 * 2026-10-02 のオーナー指摘:
 * 「そもそもスタート時に選手が敵陣地に入ってるし、ゴールしても一度完全に
 *   戻らないといけないのにそのまま始めるし」
 *
 * そのときの作りは、
 *   ・キックオフに試合中の持ち場をそのまま使っていた（FW は自ゴールから 70% ＝相手陣地）
 *   ・ゴールの瞬間に全員をキックオフの位置へ**瞬間移動**させ、次の1秒でもう蹴り出していた
 *     （1コマで 40m 以上。画面はコマの間をつなぐので、全員が一斉に滑って戻って見える）
 * どちらも例外は出ないし試合も成立するので、画面で見るまで分からない。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import { Match } from "../src/sim/engine.ts";
import { FORMATIONS } from "../src/sim/model.ts";
import { PRESET_ORDER, buildPreset } from "../src/sim/presets.ts";
import { fmtF, hypot } from "../src/sim/pymath.ts";

const HALF = C.PITCH_X / 2;
const CY = C.PITCH_Y / 2;

/** キックオフの瞬間の並びがルールどおりか。違反を文字で返す。 */
function kickoffViolations(m: Match, kickoffTeam: number): string[] {
  const mm = m as any;
  mm.resetPositions(kickoffTeam);
  const out: string[] = [];
  for (const ts of m.teams) {
    for (const a of m.actors[ts.idx]!) {
      const inOpp = ts.direction > 0 ? a.x > HALF + 1e-9 : a.x < HALF - 1e-9;
      if (inOpp) out.push(`${a.name}（${a.pos}）が相手陣地 x=${fmtF(a.x, 1)}`);
      if (ts.idx !== kickoffTeam && hypot(a.x - HALF, a.y - CY) < C.CENTER_CIRCLE_R_M) {
        out.push(`守る側の ${a.name}（${a.pos}）がセンターサークルの中`);
      }
    }
  }
  const owner = m.owner;
  if (owner === null || owner.team_idx !== kickoffTeam) out.push("蹴る側がボールを持っていない");
  else if (owner.x !== HALF || owner.y !== CY) out.push("蹴る人がセンターにいない");
  return out;
}

describe("🔴 キックオフでは全員が自陣、守る側はセンターサークルの外", () => {
  test("プリセット全チームのどちらがキックオフしても", () => {
    for (const a of PRESET_ORDER) {
      for (const b of PRESET_ORDER) {
        for (const kt of [0, 1]) {
          const bad = kickoffViolations(new Match(buildPreset(a), buildPreset(b), 1, false), kt);
          assert.deepEqual(bad, [], `${a} vs ${b}（キックオフ ${kt}）`);
        }
      }
    }
  });

  test("どのフォーメーションでも、ラインを最も高く・攻撃的にしても", () => {
    for (const formation of Object.keys(FORMATIONS)) {
      const t1 = buildPreset("プレス型");
      t1.tactics.formation = formation;
      t1.tactics.line_height = 5;
      t1.tactics.attitude = "攻撃的";
      const t2 = t1.clone();
      for (const kt of [0, 1]) {
        const bad = kickoffViolations(new Match(t1, t2, 1, false), kt);
        assert.deepEqual(bad, [], `${formation}（キックオフ ${kt}）`);
      }
    }
  });

  test("後半のキックオフ（攻める向きが入れ替わった後）でも", () => {
    const m = new Match(buildPreset("走力型"), buildPreset("堅守型"), 1, false);
    for (const ts of m.teams) ts.direction *= -1;
    assert.deepEqual(kickoffViolations(m, 1), []);
  });
});

describe("🔴 ゴールの後は全員が歩いて戻り、そろってからキックオフ", () => {
  // 🔑 ゴールが何本も入る組み合わせを含めて、全組み合わせを1試合ずつ回す
  const games = PRESET_ORDER.flatMap((a) => PRESET_ORDER.map((b) => {
    const m = new Match(buildPreset(a), buildPreset(b), 1, true, true);
    const waits: number[] = [];
    const mm = m as any;
    const orig = mm.stepRestart.bind(m);
    mm.stepRestart = () => {
      const r = m.restart!;
      orig();
      if (m.restart === null) waits.push(r.ticks);
    };
    return { label: `${a} vs ${b}`, res: m.run(), waits };
  }));


  /**
   * 前半の終わり際に入ったゴールは、戻りの検査から外す。
   *
   * 🔴 ハーフタイムでは**エンドが入れ替わって全員が反対側へ置き直される**（＝85m跳ぶ）し、
   *    後半のキックオフですぐ誰かがボールを持つ。これは戻りの不具合ではなく、
   *    競技規則どおりの切り替え（`Match.run` が `TICKS_PER_HALF` でやっている）。
   * 🔑 2026-10-03 にフォーメーションを前へ出したとき、ゴールの1つがこの窓に入って
   *    初めて表に出た。試合の中身が変わると露出する、という類の見落とし。
   */
  const crossesHalfTime = (tick: number): boolean =>
    tick < C.TICKS_PER_HALF && tick + C.RESTART_MAX_TICKS >= C.TICKS_PER_HALF;

  test("ゴールが十分な数入っている（入っていないと下の検査が空振りする）", () => {
    const goals = games.reduce((n, g) => n + g.res.score[0] + g.res.score[1], 0);
    assert.ok(goals >= 30, `ゴールが ${goals} 本しかない`);
  });

  test("戻っている間に瞬間移動しない（1秒に動けるのは最高速度まで）", () => {
    const limit = C.SPEED_MAX_MPS + C.RESTART_SETTLE_M;
    for (const { label, res } of games) {
      const fr = res.replay!.frames;
      const k = res.replay!.coord_scale;
      for (const g of res.events.filter((e) => e.type === "ゴール")) {
        if (crossesHalfTime(g.tick)) continue;
        let t = g.tick;
        do {
          for (let i = 0; i < 22; i++) {
            const d = hypot(fr[t]![3 + i * 2]! - fr[t - 1]![3 + i * 2]!,
                            fr[t]![4 + i * 2]! - fr[t - 1]![4 + i * 2]!) / k;
            assert.ok(d <= limit, `${label} ${g.time} のゴール後 ${t - g.tick}秒目に ${fmtF(d, 1)}m 動いた`);
          }
          t += 1;
        } while (t < fr.length && fr[t - 1]![2] === -1);
      }
    }
  });

  test("戻っている間は誰もボールを持たず、すぐには蹴り出さない", () => {
    for (const { label, res } of games) {
      const fr = res.replay!.frames;
      for (const g of res.events.filter((e) => e.type === "ゴール")) {
        if (g.tick + C.RESTART_MIN_TICKS >= fr.length) continue;   // 試合終了間際のゴール
        if (crossesHalfTime(g.tick)) continue;                     // 前半終了間際のゴール
        for (let t = g.tick; t < g.tick + C.RESTART_MIN_TICKS; t++) {
          assert.equal(fr[t]![2], -1, `${label} ${g.time} のゴールの ${t - g.tick}秒後に誰かが持っている`);
        }
      }
    }
  });

  test("戻りきれずに打ち切られるキックオフが無い（立ち位置の周りを回り続けない）", () => {
    for (const { label, waits } of games) {
      for (const w of waits) assert.ok(w < C.RESTART_MAX_TICKS, `${label} で ${w}秒待って打ち切った`);
    }
  });

  test("戻っている間も時計は進む（試合は 5,400 秒で終わる）", () => {
    for (const { res } of games) assert.equal(res.replay!.frames.length, C.TICKS_PER_MATCH);
  });
});
