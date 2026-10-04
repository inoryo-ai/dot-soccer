/**
 * 選手が「一人一人考えて動いている」ことを固定する。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここが壊れると「11人が塊で平行移動する試合」に戻る
 * ─────────────────────────────────────────────────────────────
 * 2026-09-30 のオーナー指摘:
 * 「全体的に連動して動きすぎてる。オフザボールの時間に一人一人考えて
 *   動いてる感じがまったくない」
 *
 * そのときの作りは、全員が毎ティック「持ち場＋ボールの位置」の式を解いて、
 * 出た点へまっすぐ歩くだけだった。**例外は出ないし試合も成立する**ので、
 * 画面で見るまで誰も気づけなかった。要件定義書 §9 の
 * 「隠しパラメーターが動きの違いとして表に出ることがこのゲームの核」が
 * まるごと死んでいた状態で、テスト82件は全部緑だった。
 *
 * → 目で見ないと分からない故障を、**数えられる形**にしてここに置く。
 *
 * 指摘前 / 指摘後の実測（バランス型 vs プレス型・seed 7）:
 *
 * | 指標 | 指摘前 | いま |
 * |---|---|---|
 * | 進む向きのそろい具合（平均） | 0.809 | 0.386 |
 * | そろい具合が0.8を超えるコマ | 61.4% | 2.3% |
 * | 隊形の散らばり | 8.5m | 8.9m（＝バラバラになったのではない） |
 *
 * 🔑 Python 版 `tests/test_movement.py` を移したもの。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import { cos, PI, sin, TAU } from "../src/sim/detmath.ts";
import { Match, play } from "../src/sim/engine.ts";
import type { Actor, Replay, RosterEntry } from "../src/sim/engine.ts";
import { buildPreset } from "../src/sim/presets.ts";
import { fmtF, hypot, mean, pyMod } from "../src/sim/pymath.ts";
import { RELEASE_STILL_MAX, releaseCounts } from "../scripts/measure.ts";

// ------------------------------------------------------------------ 物差し
//
// 🔴 **「そろって動く」だけを数えると、正しいチームプレーまで赤くなる。**
//    2026-10-01 に陣形の押し上げ（攻めるときチームごと前へ出る）を入れたところ、
//    「そろい具合」が 0.60 を超えた。だが攻撃が進むとき全員が前へ動くのは**正しい**。
//    切替直後を除いて測り直したら**もっと悪化した**（0.571 → 0.723）ので、
//    「切替のせい」という見立ても外れていた。
//
// 🔑 測るべきは「**チーム共通の流れを差し引いたあとに、一人一人の違いが残るか**」。
//    共通の速度を引いた残りが大きいほど、各自が自分の判断で動いている。
//    完全な塊なら 0 になる（「物差しの自己検査」が確かめている）。
//
// 指摘前 / いま（バランス型 vs プレス型・seed 7・悪いほうのチーム）:
//
// | 指標 | 指摘前 | いま | 門 |
// |---|---|---|---|
// | 共通の流れを引いた残り | 0.585 | 0.784 | 0.70 以上 |
// | 進む向きのそろい具合 | 0.809 | 0.571 | 0.70 未満 |
const MIN_INDIVIDUALITY = 0.70;     // 共通の流れを引いた残り（1.0＝全員バラバラ）
const MAX_MEAN_ALIGNMENT = 0.70;    // 進む向きのそろい具合（1.0＝全員同じ向き）
const MIN_MOVE_M = 0.15;            // これ未満は「止まっている」として向きを数えない

type Vec = [number, number];

/** 向きのそろい具合。1.0 なら全員が完全に同じ向き＝塊。 */
function alignment(units: Vec[]): number {
  const mx = units.reduce((a, u) => a + u[0], 0) / units.length;
  const my = units.reduce((a, u) => a + u[1], 0) / units.length;
  return hypot(mx, my);
}

/**
 * チーム共通の流れを引いたあと、どれだけ自分の動きが残るか。
 *
 * 🔑 完全な塊なら 0、全員バラバラなら 1 に近づく。
 *    **これが「一人一人考えて動いているか」の本体。**
 */
function individuality(vectors: Vec[]): number {
  if (vectors.length === 0) return 0.0;
  const mx = vectors.reduce((a, v) => a + v[0], 0) / vectors.length;
  const my = vectors.reduce((a, v) => a + v[1], 0) / vectors.length;
  const total = vectors.reduce((a, v) => a + hypot(v[0], v[1]), 0);
  if (total <= 0) return 0.0;
  const rest = vectors.reduce((a, v) => a + hypot(v[0] - mx, v[1] - my), 0);
  return rest / total;
}

/** Python の statistics.pstdev（母標準偏差）。門が広いので素直な2回走査で足りる。 */
function pstdev(values: number[]): number {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / values.length);
}

function outfieldIndexes(roster: RosterEntry[], team: number): number[] {
  return roster.flatMap((p, i) => (p.team === team && p.pos !== "GK" ? [i] : []));
}

describe("物差しの自己検査（台帳・天城 [3回] 機械化済みの規則）", () => {
  // 🔴 作った入力で先に確かめる。ここを飛ばすと、**いつも0.8を返すだけの
  //    壊れた物差し**でも緑になる。

  test("全員が同じ向きなら 1", () => {
    const got = alignment(Array.from({ length: 10 }, (): Vec => [1.0, 0.0]));
    assert.ok(Math.abs(got - 1.0) < 5e-7, String(got));
  });

  test("逆向きは打ち消し合って 0", () => {
    assert.ok(Math.abs(alignment([[1.0, 0.0], [-1.0, 0.0]])) < 5e-7);
  });

  test("散らばった向きは低い", () => {
    const units = Array.from({ length: 8 }, (_, i): Vec => [cos(i * TAU / 8), sin(i * TAU / 8)]);
    assert.ok(alignment(units) < 0.01);
  });

  test("🔴 全員が同じ動きなら個性は 0（ここが 0 でない物差しは使えない）", () => {
    const got = individuality(Array.from({ length: 11 }, (): Vec => [3.0, 1.0]));
    assert.ok(Math.abs(got) < 5e-7, String(got));
  });

  test("逆向きの動きは個性 1", () => {
    assert.ok(Math.abs(individuality([[1.0, 0.0], [-1.0, 0.0]]) - 1.0) < 5e-7);
  });
});

describe("🔴 塊で動いていない（オーナー指摘そのものの検査）", () => {
  let cached: Replay | undefined;
  const replay = (): Replay => {
    if (cached === undefined) {
      cached = play(buildPreset("バランス型"), buildPreset("プレス型"), 7, false, true).replay!;
    }
    return cached;
  };

  function perFrame(team: number): [number[], number[]] {
    const rep = replay();
    const k = rep.coord_scale;
    const frames = rep.frames;
    const idx = outfieldIndexes(rep.roster, team);
    const aligns: number[] = [];
    const indivs: number[] = [];
    for (let i = 0; i < frames.length - 1; i++) {
      const cur = frames[i]!;
      const nxt = frames[i + 1]!;
      const vectors: Vec[] = idx.map((j): Vec => [
        (nxt[3 + j * 2]! - cur[3 + j * 2]!) / k,
        (nxt[4 + j * 2]! - cur[4 + j * 2]!) / k,
      ]);
      const moving = vectors.filter((v) => hypot(v[0], v[1]) > MIN_MOVE_M);
      if (moving.length < 5) continue;
      const units = moving.map(([x, y]): Vec => [x / hypot(x, y), y / hypot(x, y)]);
      aligns.push(alignment(units));
      indivs.push(individuality(vectors));
    }
    return [aligns, indivs];
  }

  test("🔴 共通の流れを引いても、自分の動きが残っている（これが本体）", async (t) => {
    for (const team of [0, 1]) {
      await t.test(`team=${team}`, () => {
        const [, indivs] = perFrame(team);
        assert.ok(indivs.length > 100, "動いているコマが少なすぎる");
        const got = mean(indivs);
        assert.ok(got > MIN_INDIVIDUALITY,
                  `共通の流れを引いた残りが ${fmtF(got, 3)}（指摘前 0.585 / 門 ${MIN_INDIVIDUALITY}）`);
      });
    }
  });

  test("全員が同じ向きを向いていない", async (t) => {
    for (const team of [0, 1]) {
      await t.test(`team=${team}`, () => {
        const [aligns] = perFrame(team);
        const got = mean(aligns);
        assert.ok(got < MAX_MEAN_ALIGNMENT, `向きのそろい具合 ${fmtF(got, 3)}（指摘前 0.809）`);
      });
    }
  });

  test("🔴 隊形はチームとして保たれている（バラバラになっただけでは直したことにならない）", () => {
    // 隊形の散らばりが広がりすぎると、フォーメーションも戦術も意味を失う
    // （GD-05「作戦と育成が噛み合って初めてチームが成り立つ」）。
    const rep = replay();
    const k = rep.coord_scale;
    const idx = outfieldIndexes(rep.roster, 0);
    const spreads: number[] = [];
    for (let f = 0; f < rep.frames.length; f += 20) {
      const frame = rep.frames[f]!;
      const pts = idx.map((j): Vec => [frame[3 + j * 2]! / k, frame[4 + j * 2]! / k]);
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      spreads.push(pstdev(pts.map((p) => hypot(p[0] - cx, p[1] - cy))));
    }
    const m = mean(spreads);
    assert.ok(m < 18.0, `隊形が崩れすぎている（散らばり ${fmtF(m, 1)}m）`);
    assert.ok(m > 3.0, `全員が重なっている（散らばり ${fmtF(m, 1)}m）`);
  });
});

describe("考える仕組みそのものが生きている", () => {
  let cached: Match | undefined;
  const match = (): Match => {
    if (cached === undefined) {
      cached = new Match(buildPreset("バランス型"), buildPreset("パス型"), 3, false);
      cached.run();
    }
    return cached;
  };
  const allActors = () => match().actors.flat();

  test("🔴 判断の秒が人によってずれている（全員が同じ秒に考え直すと、結局そろって動く）", () => {
    const offsets = allActors().map((a) => a.decide_offset);
    assert.ok(new Set(offsets).size > 1, "判断の秒が全員同じ");
  });

  test("同じ枠でも立ち位置が人によって違う", () => {
    const seats = allActors().map((a) => `${a.seat_dx},${a.seat_dy}`);
    assert.equal(new Set(seats).size, seats.length, "持ち場のゆらぎが重複している");
  });

  test("攻守の切り替えに気づく遅れが人によって違う", () => {
    const lags = allActors().map((a) => a.lag);
    assert.ok(new Set(lags).size > 1, "攻守の切り替えに全員が同時に気づいている");
  });

  test("🔴 どの意思にも本気度が決まっている（抜けるとそこだけ既定値になって差が消える）", () => {
    const used = new Set(allActors().map((a) => a.intent));
    for (const intent of used) assert.ok(intent in C.EFFORT, `${intent} の本気度が決まっていない`);
  });

  /**
   * 試合の途中の盤面を作り、ホームが持っている状態にする。
   * 🔑 `ballX` でボールの位置（＝局面）だけを変える。選手の位置はそのまま。
   */
  const attackingBoard = (ballX: number): Match => {
    const m = new Match(buildPreset("バランス型"), buildPreset("パス型"), 3, false);
    m.run();
    // 🔑 90分走った後は全員が疲れていて、走る意思を選びにくい（D-44 の体力の配分）。
    //    ここで見たいのは「局面で選ぶものが変わるか」なので、体力は満タンに戻してから見る
    for (const side of m.actors) for (const a of side) a.stamina = a.max_stamina;
    const holder = m.actors[0]!.find((a) => a.pos === "MF")!;
    holder.x = ballX;
    holder.y = C.PITCH_Y / 2;
    m.owner = holder;
    m.ball_x = ballX;
    m.ball_y = C.PITCH_Y / 2;
    m.teams[0].direction = 1;
    m.teams[1].direction = -1;
    return m;
  };
  const intentsAt = (ballX: number): Map<Actor, string> => {
    const m = attackingBoard(ballX);
    const oppDeep: number = (m as any).lastDefenderX(m.teams[1]);
    const out = new Map<Actor, string>();
    for (const a of m.actors[0]!) {
      if (a.pos === "GK" || a === m.owner) continue;
      (m as any).decideAttack(m.teams[0], a, oppDeep);
      out.set(a, a.intent);
    }
    return out;
  };

  test("攻撃時の意思が何種類も出る（1種類しか出ないなら、選んでいるとは言えない）", () => {
    const seen = new Set<string>();
    for (const x of [30.0, 55.0, 80.0, 92.0]) for (const intent of intentsAt(x).values()) seen.add(intent);
    assert.ok(seen.size >= 3, `攻撃時の意思が ${JSON.stringify([...seen])} しか出ない`);
  });

  test("🔴 同じ選手でも、局面（ボールの位置）で選ぶ意思が変わる（D-41: くじではなく局面で選ぶ）", () => {
    // 🔑 くじの頃は、自陣で持っていても敵陣で持っていても同じ割合で裏へ走っていた
    const own = [...intentsAt(30.0).values()];
    const opp = [...intentsAt(85.0).values()];
    const changed = own.filter((intent, i) => intent !== opp[i]).length;
    assert.ok(changed >= 2, `ボールを敵陣へ運んでも意思が変わった選手が ${changed}人だけ: ${own} → ${opp}`);
  });

  test("🔴 同じ局面なら同じ意思を選ぶ（くじを引かない・ガンビットが「指示」になる土台）", () => {
    const first = [...intentsAt(70.0).values()];
    for (let i = 0; i < 5; i++) assert.deepEqual([...intentsAt(70.0).values()], first);
  });
});

describe("🔴 向きを変えるには時間がかかる（瞬時に変えられると、全員が同じ瞬間に反転できてしまう）", () => {
  test("1秒で回れるのは上限まで", () => {
    const m = new Match(buildPreset("走力型"), buildPreset("堅守型"), 11, false);
    const mm = m as any;
    mm.resetPositions(0);
    const a = m.actors[0]![5]!;
    a.heading = 0.0;
    const before = a.heading;
    // 真後ろ（180度）を指示しても、1秒では上限までしか回れない
    mm.step(a, a.x - 30.0, a.y);
    const turned = Math.abs(pyMod(a.heading - before + PI, TAU) - PI);
    assert.ok(turned <= C.TURN_RATE_RAD + 1e-9,
              `1秒で ${fmtF(turned * 180 / PI, 0)}度 回っている`);
  });
});

describe("🔴 出した人はその秒のうちにボールを持たない選手へ戻る（D-46・オーナー指摘）", () => {
  // 2026-10-05「パスという行動をした直後に選手が硬直してる。本来パスした後は味方にボールが
  // 渡った渡ってないに限らず、オフザボールの動きになるべき」。直す前は出した秒の移動が 0.00m（100%）。
  const counts = (): number[] => {
    const total = [0, 0, 0, 0];
    for (const [home, away, seed] of [["バランス型", "プレス型", 7], ["パス型", "走力型", 3],
                                      ["堅守型", "裏抜け型", 5]] as const) {
      releaseCounts(play(buildPreset(home), buildPreset(away), seed, true, true))
        .forEach((c, i) => { total[i]! += c; });
    }
    return total;
  };

  test("🔴 出した秒にほぼ動かなかったパスは上限以下", () => {
    const [n, , still] = counts() as [number, number, number, number];
    assert.ok(n > 100, `パスが ${n}本しか数えられていない（物差しが壊れている）`);
    assert.ok(still / n <= RELEASE_STILL_MAX,
              `出した秒にほぼ動かなかった ${fmtF(100 * still / n, 0)}%（上限 ${fmtF(100 * RELEASE_STILL_MAX, 0)}%）`);
  });

  test("蹴る動作の秒数は1秒より短い（1秒なら出した秒に動く時間が残らない）", () => {
    assert.ok(C.PASS_KICK_SECONDS > 0 && C.PASS_KICK_SECONDS < 1);
  });
});

describe("🔴 疲れが下げるのは全力の上限だけ（D-47）", () => {
  // 2026-10-05 実測: 速さ全体に疲れを掛けていたので、後半の走行が前半の −27%（現実 −2.4%）・
  // 最後の15分の高強度がゼロ（現実 −20〜45%）だった。疲れた選手もジョグはできる
  const m = new Match(buildPreset("バランス型"), buildPreset("堅守型"), 3, false);
  const a = m.actors[0]![5]!;

  test("体力が空でもジョグ（最大速度の半分）は落ちない", () => {
    a.stamina = 0;
    assert.equal(a.pace(0.5), a.max_speed * 0.5);
  });

  test("体力が空だと全力は上限まで落ちる", () => {
    a.stamina = 0;
    assert.equal(a.pace(1.0), a.max_speed * C.STAMINA_SPEED_FLOOR);
    a.stamina = a.max_stamina;
    assert.equal(a.pace(1.0), a.max_speed);
  });
});
