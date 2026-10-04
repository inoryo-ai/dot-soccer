/**
 * 練習場（D-48）。11対11 の前に、少ない人数で「入れる／阻止する」を覚えるための小さな場所。
 *
 * 🔑 **物理は 11対11 と同じ**（`physics.ts`）。練習場で覚えた動きが試合でも同じ物理で動くように、
 *    走る・奪い合う・抜く・撃つ・GKの立ち位置の式をここに写さない。
 * 🔑 ピッチ（105×68m）と座標はそのまま。ゴール（x=105）の前に区切った場所だけを使う
 *    （本物の練習でコーンを置いて区切るのと同じ）。画面もそのまま使える。
 * 🔑 乱数はここの `PyRandom` だけ（D-08）。同じシードなら同じ練習になる。
 *
 * S1（攻め1対守り1＋GK）: 2人が攻めと守りを交互に受け持つ。1回の攻撃は
 * 「入った・止められた・奪われた・外へ出した・時間切れ」のどれかで終わる。
 *
 * 🔴 いまの攻め・守りの判断（`decideAttack1v1` / 守りは寄せるだけ）は**学習の前の比べる相手**。
 *    学習した方針と入れ替える（Phase 0 §9）。物理と違い、ここは 11対11 の評価式を写したものではない。
 */

import { Actor } from "./actor.ts";
import * as C from "./constants.ts";
import { atan2, cos, PI, sin } from "./detmath.ts";
import type { MatchEvent, Replay, RosterEntry } from "./engine.ts";
import type { Player } from "./model.ts";
import * as Phys from "./physics.ts";
import { fmtF, hypot, pyRound } from "./pymath.ts";
import { PyRandom } from "./pyrandom.ts";
import { VALUE_TABLE } from "./value_table.ts";

/** 1回の攻撃の終わり方 */
export type Outcome = "GOAL" | "SAVED" | "WON" | "OUT" | "TIME";

/** 練習場の広さ。攻めるゴールは x=PITCH_X、区切りは x0〜x1・y0〜y1 */
export interface ArenaArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function arenaArea(depth = C.ARENA_DEPTH_M, width = C.ARENA_WIDTH_M): ArenaArea {
  return { x0: C.PITCH_X - depth, y0: C.PITCH_Y / 2 - width / 2,
           x1: C.PITCH_X, y1: C.PITCH_Y / 2 + width / 2 };
}

/** 練習の結果。`replay` は試合と同じ形（`area` つき）なので、試合の画面でそのまま再生できる */
export interface ArenaResult {
  seed: number;
  names: [string, string];
  /** 2人それぞれの得点 */
  score: [number, number];
  /** 攻撃ごとの [攻めた人の番号 0/1, 終わり方, かかった秒] */
  attacks: [number, Outcome, number][];
  events: MatchEvent[];
  replay: Replay;
}

/** S1 の1回の攻撃に関わる3人。攻め・守りは同じチームの番号で表す（攻め=0・守り=1） */
interface Cast {
  attacker: Actor;
  defender: Actor;
  keeper: Actor;
}

export class Arena {
  readonly area: ArenaArea;
  readonly rng: PyRandom;
  /** 名簿の順（コマの並び）: [選手A, 選手B, GK] */
  readonly men: Actor[];
  ball_x = 0.0;
  ball_y = 0.0;
  owner: Actor | null = null;
  tick = 0;
  frames: number[][] = [];
  events: MatchEvent[] = [];
  private contest_cd = 0;

  readonly seed: number;

  constructor(playerA: Player, playerB: Player, keeper: Player, seed: number,
              area: ArenaArea = arenaArea()) {
    this.seed = seed;
    this.area = area;
    this.rng = new PyRandom(seed);
    // 🔑 スロットの位置は使わない（練習場では毎回置き直す）。ポジションだけ意味がある
    this.men = [new Actor(playerA, 0, ["FW", 0, 0]), new Actor(playerB, 1, ["FW", 0, 0]),
                new Actor(keeper, 1, ["GK", 0, 0])];
  }

  /** 攻撃を `n` 回（A・B が交互に攻める）。 */
  run(n: number): ArenaResult {
    const score: [number, number] = [0, 0];
    const attacks: [number, Outcome, number][] = [];
    for (let i = 0; i < n; i++) {
      const who = i % 2;
      const cast: Cast = { attacker: this.men[who]!, defender: this.men[1 - who]!, keeper: this.men[2]! };
      const start = this.tick;
      const outcome = this.attack(cast);
      if (outcome === "GOAL") score[who as 0 | 1] += 1;
      attacks.push([who, outcome, this.tick - start]);
      // 🔑 見る人のために、終わった場面を少し止めて見せる（シミュレーションの結果には効かない）
      for (let k = 0; k < C.ARENA_PAUSE_TICKS; k++) this.record();
    }
    return { seed: this.seed, names: [this.men[0]!.name, this.men[1]!.name], score, attacks,
             events: this.events, replay: this.replay() };
  }

  /** 1回の攻撃。 */
  private attack(c: Cast): Outcome {
    const a = this.area;
    // 🔑 体力は攻撃ごとに戻す（S1 は1回ずつの勝負を覚える段階。疲れは段階が進んでから）
    for (const m of this.men) m.stamina = m.max_stamina;
    c.attacker.x = a.x0 + 1.0;
    c.attacker.y = C.PITCH_Y / 2 + this.rng.uniform(-C.ARENA_START_SPREAD_M, C.ARENA_START_SPREAD_M);
    c.attacker.heading = 0.0;
    c.defender.x = a.x0 + C.ARENA_DEFENDER_START_M;
    c.defender.y = C.PITCH_Y / 2;
    c.defender.heading = PI;
    [c.keeper.x, c.keeper.y] = Phys.keeperAim(C.PITCH_X, -1, c.attacker.y);
    c.keeper.heading = PI;
    this.owner = c.attacker;
    this.ball_x = c.attacker.x;
    this.ball_y = c.attacker.y;
    this.contest_cd = C.TACKLE_COOLDOWN_TICKS;
    this.record();

    for (let t = 0; t < C.ARENA_MAX_TICKS; t++) {
      this.tick += 1;
      // 1. ボールを持たない2人が動く（11対11 の `moveAll` と同じ順番）
      Phys.stepActor(c.defender, this.ball_x, this.ball_y,
                     (C.EFFORT["ENGAGE"] ?? 1.0) * C.EFFORT_SCALE, 1.0, false);
      const [kx, ky] = Phys.keeperAim(C.PITCH_X, -1, this.ball_y);
      Phys.stepActor(c.keeper, kx, ky, (C.EFFORT["GOALKEEP"] ?? 0.7) * C.EFFORT_SCALE, 1.0, true);
      // 2. ボール
      const end = this.resolve(c);
      this.record();
      if (end !== null) return end;
    }
    this.log("時間切れ", c.attacker, "");
    return "TIME";
  }

  /** ボールの処理。終わったら終わり方を返す。 */
  private resolve(c: Cast): Outcome | null {
    const h = c.attacker;
    const opps = [c.defender, c.keeper];
    // 奪い合い（11対11 の `contest` と同じ式。近くに味方はいない）
    if (this.contest_cd > 0) {
      this.contest_cd -= 1;
    } else {
      let challenger: Actor | null = null;
      let bestD = C.TACKLE_RADIUS_M;
      for (const o of opps) {
        const dd = hypot(o.x - h.x, o.y - h.y);
        if (dd < bestD) {
          challenger = o;
          bestD = dd;
        }
      }
      if (challenger !== null) {
        const press = Math.max(0, Math.min(100, challenger.player.press));
        if (this.rng.random() < Phys.tackleChance(h, challenger, press, 0)) {
          return this.lose(challenger, `${h.name} から`);
        }
        this.contest_cd = C.TACKLE_COOLDOWN_TICKS;
      }
    }

    const act = this.decideAttack1v1(c);
    if (act.kind === "SHOOT") {
      const dist = hypot(C.PITCH_X - h.x, C.PITCH_Y / 2 - h.y);
      const xg = Phys.expectedGoalAt(h, opps, C.PITCH_X, h.x, h.y, dist);
      if (this.rng.random() < xg) {
        this.ball_x = C.PITCH_X;
        this.ball_y = C.PITCH_Y / 2;
        this.owner = null;
        this.log("ゴール", h, `${fmtF(dist, 0)}m`);
        return "GOAL";
      }
      this.ball_x = c.keeper.x;
      this.ball_y = c.keeper.y;
      this.owner = c.keeper;
      this.log("シュート", h, `${fmtF(dist, 0)}m 枠外/セーブ`);
      return "SAVED";
    }
    // 運ぶ・抜く（11対11 の `dribble` と同じ式）
    const defender = Phys.opponentAhead(opps, h.x, h.y, h.x + act.dirX * 100.0, h.y + act.dirY * 100.0);
    if (defender !== null && this.rng.random() >= Phys.dribbleChance(h, defender)) {
      return this.lose(defender, `${h.name} のドリブルを止めた`);
    }
    const [nx, ny] = Phys.dribbleTarget(h, act.dirX, act.dirY);
    const stepLen = hypot(nx - h.x, ny - h.y);
    h.heading = atan2(ny - h.y, nx - h.x);
    h.x = nx;
    h.y = ny;
    h.stamina = Math.max(0.0, h.stamina - stepLen * C.STAMINA_DRAIN_PER_METER);
    this.ball_x = h.x;
    this.ball_y = h.y;
    const a = this.area;
    if (h.x < a.x0 || h.y < a.y0 || h.y > a.y1) {
      this.owner = null;
      this.log("外へ", h, "");
      return "OUT";
    }
    return null;
  }

  private lose(winner: Actor, detail: string): Outcome {
    this.owner = winner;
    this.ball_x = winner.x;
    this.ball_y = winner.y;
    this.log("奪取", winner, detail);
    return "WON";
  }

  /**
   * 学習の前の攻め（比べる相手）。撃つか、5つの向きのどれかへ運ぶか。
   * 運ぶ先の価値＝場所の価値（価値の表）× 持ち続けられる確率（前の相手を抜ける確率）。
   * 撃つ価値＝入る確率（`SHOT_MIN_XG` 以上のときだけ）。
   */
  private decideAttack1v1(c: Cast): { kind: "SHOOT" } | { kind: "DRIBBLE"; dirX: number; dirY: number } {
    const h = c.attacker;
    const opps = [c.defender, c.keeper];
    const t = VALUE_TABLE;
    if (t === null) throw new Error("練習場には価値の表が要る（node scripts/build_value_table.ts）");
    const dist = hypot(C.PITCH_X - h.x, C.PITCH_Y / 2 - h.y);
    let bestShoot = -1.0;
    if (dist <= C.SHOOT_RANGE_M) {
      const xg = Phys.expectedGoalAt(h, opps, C.PITCH_X, h.x, h.y, dist);
      if (xg >= C.SHOT_MIN_XG) bestShoot = xg;
    }
    const toward = atan2(C.PITCH_Y / 2 - h.y, C.PITCH_X - h.x);
    let best: { kind: "DRIBBLE"; dirX: number; dirY: number } | null = null;
    let bestV = -1.0;
    for (const off of C.ARENA_DRIBBLE_ANGLES) {
      const ang = toward + off;
      const dirX = cos(ang);
      const dirY = sin(ang);
      const [nx, ny] = Phys.dribbleTarget(h, dirX, dirY);
      const a = this.area;
      if (nx < a.x0 || ny < a.y0 || ny > a.y1) continue;     // 区切りの外へは運ばない
      const ahead = Phys.opponentAhead(opps, h.x, h.y, h.x + dirX * 100.0, h.y + dirY * 100.0);
      const keep = ahead === null ? 1.0 : Phys.dribbleChance(h, ahead);
      const v = Phys.tableValueAt(t, nx, ny) * keep;
      if (v > bestV) {
        bestV = v;
        best = { kind: "DRIBBLE", dirX, dirY };
      }
    }
    if (best === null || bestShoot >= bestV) return { kind: "SHOOT" };
    return best;
  }

  private log(type: string, who: Actor, detail: string): void {
    const mm = String(Math.floor(this.tick / 60)).padStart(2, "0");
    const ss = String(this.tick % 60).padStart(2, "0");
    // 🔑 得点の表示（試合の画面）はチーム名で数えるので、選手の名前をチーム名にする
    this.events.push({ time: `${mm}:${ss}`, tick: this.frames.length, type, team: who.name,
                       player: who.name, detail });
  }

  /** 試合と同じ形のコマ（`Match.recordFrame`）。 */
  private record(): void {
    const k = C.REPLAY_COORD_SCALE;
    const frame = [pyRound(this.ball_x * k), pyRound(this.ball_y * k),
                   this.owner === null ? -1 : this.men.indexOf(this.owner)];
    for (const m of this.men) frame.push(pyRound(m.x * k), pyRound(m.y * k));
    this.frames.push(frame);
  }

  private replay(): Replay {
    const roster: RosterEntry[] = this.men.map((m) => ({ name: m.name, team: m.team_idx, pos: m.pos,
                                                         type: m.player.typeName }));
    return { sample_ticks: 1, coord_scale: C.REPLAY_COORD_SCALE, pitch: [C.PITCH_X, C.PITCH_Y],
             roster, frames: this.frames,
             area: [this.area.x0, this.area.y0, this.area.x1, this.area.y1] };
  }
}

/** 練習を回す。 */
export function playArena(playerA: Player, playerB: Player, keeper: Player, seed: number,
                          attacks = C.ARENA_ATTACKS): ArenaResult {
  return new Arena(playerA, playerB, keeper, seed).run(attacks);
}
