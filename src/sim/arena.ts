/**
 * 練習場（D-48）。11対11 の前に、少ない人数で「入れる／阻止する」を覚えるための小さな場所。
 *
 * 🔑 **物理は 11対11 と同じ**（`physics.ts`）。練習場で覚えた動きが試合でも同じ物理で動くように、
 *    走る・奪い合う・抜く・撃つ・GKの立ち位置の式をここに写さない。
 * 🔑 ピッチ（105×68m）と座標はそのまま。ゴール（x=105）の前に区切った場所だけを使う
 *    （本物の練習でコーンを置いて区切るのと同じ）。画面もそのまま使える。
 * 🔑 乱数はここの `PyRandom` だけ（D-08）。同じシードなら同じ練習になる。
 * 🔑 **判断は差し替えられる**（`AttackPolicy` / `DefendPolicy`）。学習の前の判断（`baselineAttack` /
 *    `baselineDefend`）と学習した判断（`policy.ts`）を、同じ物理・同じシードで比べるため。
 *
 * S1（攻め1対守り1＋GK）: 2人が攻めと守りを交互に受け持つ。1回の攻撃は
 * 「入った・止められた・奪われた・外へ出した・時間切れ」のどれかで終わる。
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
import type { ValueTable } from "./value_table.ts";

/** 1回の攻撃の終わり方 */
export type Outcome = "GOAL" | "SAVED" | "WON" | "OUT" | "TIME";
export const OUTCOMES: readonly Outcome[] = ["GOAL", "SAVED", "WON", "OUT", "TIME"];

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

/** その場面（判断が読むもの）。判断は書き換えない */
export interface Scene {
  readonly attacker: Actor;
  readonly defender: Actor;
  readonly keeper: Actor;
  readonly area: ArenaArea;
  readonly table: ValueTable;
}

/** 攻めの行動: 撃つ／決めた向き（単位ベクトル）へ運ぶ */
export type AttackAct = { kind: "SHOOT" } | { kind: "DRIBBLE"; dirX: number; dirY: number };

/** 守りの行動: どこへ・どれだけの本気度で向かうか（`urgent` は着くまでの時間で速さを落とさない） */
export interface DefendMove {
  tx: number;
  ty: number;
  effort: number;
  urgent: boolean;
}

export interface AttackPolicy {
  decide(s: Scene): AttackAct;
}
export interface DefendPolicy {
  move(s: Scene): DefendMove;
}

/** 攻撃1回の記録。**学習の点数の材料**（Phase 0 §9.3）と、抜け道の見張り（§9.5）に使う */
export interface AttackLog {
  who: number;
  outcome: Outcome;
  ticks: number;
  /** 攻める向きで見た、攻めの場所の価値（始めと終わり）＝フィールドの区分けの点数 */
  startValue: number;
  endValue: number;
  /** 攻めがドリブルの勝負に勝った回数・守りが奪い合いを仕掛けて止められた回数 */
  duelsWon: number;
  /** ドリブルの勝負（攻めが前の相手を抜きにかかった）の回数と、そのうち抜いた回数（現実の「仕掛けの成功率」と比べる） */
  takeOns: number;
  takeOnsWon: number;
  /** 行動の回数（撃つ・運ぶ） */
  shots: number;
  dribbles: number;
}

/** 練習の結果。`replay` は試合と同じ形（`area` つき）なので、試合の画面でそのまま再生できる */
export interface ArenaResult {
  seed: number;
  names: [string, string];
  /** 2人それぞれの得点 */
  score: [number, number];
  /** 攻撃ごとの [攻めた人の番号 0/1, 終わり方, かかった秒] */
  attacks: [number, Outcome, number][];
  logs: AttackLog[];
  events: MatchEvent[];
  replay: Replay;
}

/** 練習のしかた */
export interface ArenaOptions {
  attack?: AttackPolicy;
  defend?: DefendPolicy;
  /** false ならコマと出来事を残さない（学習で速く回すため。結果は同じ） */
  record?: boolean;
  area?: ArenaArea;
}

function needTable(): ValueTable {
  if (VALUE_TABLE === null) throw new Error("練習場には価値の表が要る（node scripts/build_value_table.ts）");
  return VALUE_TABLE;
}

/** 攻める向き（x=PITCH_X のゴール）で見た、その場所の価値 */
export function placeValue(t: ValueTable, x: number, y: number): number {
  return Phys.tableValueAt(t, x, y);
}

/**
 * 学習の前の攻め（比べる相手）。撃つか、5つの向きのどれかへ運ぶか。
 * 運ぶ先の価値＝場所の価値（価値の表）× 持ち続けられる確率（前の相手を抜ける確率）。
 * 撃つ価値＝入る確率（`SHOT_MIN_XG` 以上のときだけ）。
 */
export const baselineAttack: AttackPolicy = {
  decide(s: Scene): AttackAct {
    const h = s.attacker;
    const opps = [s.defender, s.keeper];
    const dist = hypot(C.PITCH_X - h.x, C.PITCH_Y / 2 - h.y);
    let bestShoot = -1.0;
    if (dist <= C.SHOOT_RANGE_M) {
      const xg = Phys.expectedGoalAt(h, opps, C.PITCH_X, h.x, h.y, dist);
      if (xg >= C.SHOT_MIN_XG) bestShoot = xg;
    }
    const toward = atan2(C.PITCH_Y / 2 - h.y, C.PITCH_X - h.x);
    let best: AttackAct | null = null;
    let bestV = -1.0;
    for (const off of C.ARENA_DRIBBLE_ANGLES) {
      const ang = toward + off;
      const dirX = cos(ang);
      const dirY = sin(ang);
      const [nx, ny] = Phys.dribbleTarget(h, dirX, dirY);
      if (!inside(s.area, nx, ny)) continue;     // 区切りの外へは運ばない
      const ahead = Phys.opponentAhead(opps, h.x, h.y, h.x + dirX * 100.0, h.y + dirY * 100.0);
      const keep = ahead === null ? 1.0 : Phys.dribbleChance(h, ahead);
      const v = placeValue(s.table, nx, ny) * keep;
      if (v > bestV) {
        bestV = v;
        best = { kind: "DRIBBLE", dirX, dirY };
      }
    }
    if (best === null || bestShoot >= bestV) return { kind: "SHOOT" };
    return best;
  },
};

/** 学習の前の守り（比べる相手）。11対11 の「寄せる」（ENGAGE）と同じく、ボールへ全力で向かう */
export const baselineDefend: DefendPolicy = {
  move(s: Scene): DefendMove {
    return { tx: s.attacker.x, ty: s.attacker.y, effort: C.EFFORT["ENGAGE"] ?? 1.0, urgent: true };
  },
};

export function inside(a: ArenaArea, x: number, y: number): boolean {
  return x >= a.x0 && y >= a.y0 && y <= a.y1;
}

export class Arena {
  readonly area: ArenaArea;
  readonly rng: PyRandom;
  readonly seed: number;
  /** 名簿の順（コマの並び）: [選手A, 選手B, GK] */
  readonly men: Actor[];
  readonly table: ValueTable;
  ball_x = 0.0;
  ball_y = 0.0;
  owner: Actor | null = null;
  tick = 0;
  frames: number[][] = [];
  events: MatchEvent[] = [];
  private contest_cd = 0;
  private readonly attackPolicy: AttackPolicy;
  private readonly defendPolicy: DefendPolicy;
  private readonly recording: boolean;

  constructor(playerA: Player, playerB: Player, keeper: Player, seed: number, opts: ArenaOptions = {}) {
    this.seed = seed;
    this.area = opts.area ?? arenaArea();
    this.rng = new PyRandom(seed);
    this.table = needTable();
    this.attackPolicy = opts.attack ?? baselineAttack;
    this.defendPolicy = opts.defend ?? baselineDefend;
    this.recording = opts.record ?? true;
    // 🔑 スロットの位置は使わない（練習場では毎回置き直す）。ポジションだけ意味がある
    this.men = [new Actor(playerA, 0, ["FW", 0, 0]), new Actor(playerB, 1, ["FW", 0, 0]),
                new Actor(keeper, 1, ["GK", 0, 0])];
  }

  /** 攻撃を `n` 回（A・B が交互に攻める）。 */
  run(n: number): ArenaResult {
    const score: [number, number] = [0, 0];
    const attacks: [number, Outcome, number][] = [];
    const logs: AttackLog[] = [];
    for (let i = 0; i < n; i++) {
      const who = i % 2;
      const log = this.attack(who);
      if (log.outcome === "GOAL") score[who as 0 | 1] += 1;
      attacks.push([who, log.outcome, log.ticks]);
      logs.push(log);
      // 🔑 見る人のために、終わった場面を少し止めて見せる（シミュレーションの結果には効かない）
      for (let k = 0; k < C.ARENA_PAUSE_TICKS; k++) this.record();
    }
    return { seed: this.seed, names: [this.men[0]!.name, this.men[1]!.name], score, attacks, logs,
             events: this.events, replay: this.replay() };
  }

  /** 1回の攻撃。`who` が攻め、もう1人が守る。 */
  attack(who: number): AttackLog {
    const s: Scene = { attacker: this.men[who]!, defender: this.men[1 - who]!, keeper: this.men[2]!,
                       area: this.area, table: this.table };
    const a = this.area;
    // 🔑 体力は攻撃ごとに戻す（S1 は1回ずつの勝負を覚える段階。疲れは段階が進んでから）
    for (const m of this.men) m.stamina = m.max_stamina;
    s.attacker.x = a.x0 + 1.0;
    s.attacker.y = C.PITCH_Y / 2 + this.rng.uniform(-C.ARENA_START_SPREAD_M, C.ARENA_START_SPREAD_M);
    s.attacker.heading = 0.0;
    s.defender.x = a.x0 + C.ARENA_DEFENDER_START_M;
    s.defender.y = C.PITCH_Y / 2;
    s.defender.heading = PI;
    [s.keeper.x, s.keeper.y] = Phys.keeperAim(C.PITCH_X, -1, s.attacker.y);
    s.keeper.heading = PI;
    this.owner = s.attacker;
    this.ball_x = s.attacker.x;
    this.ball_y = s.attacker.y;
    this.contest_cd = C.TACKLE_COOLDOWN_TICKS;
    this.record();
    const log: AttackLog = { who, outcome: "TIME", ticks: 0,
                             startValue: placeValue(this.table, this.ball_x, this.ball_y), endValue: 0,
                             duelsWon: 0, takeOns: 0, takeOnsWon: 0, shots: 0, dribbles: 0 };

    for (let t = 0; t < C.ARENA_MAX_TICKS; t++) {
      this.tick += 1;
      log.ticks += 1;
      // 1. ボールを持たない2人が動く（11対11 の `moveAll` と同じ順番）
      const mv = this.defendPolicy.move(s);
      Phys.stepActor(s.defender, mv.tx, mv.ty, mv.effort * C.EFFORT_SCALE, C.TICK_S, !mv.urgent);
      const [kx, ky] = Phys.keeperAim(C.PITCH_X, -1, this.ball_y);
      Phys.stepActor(s.keeper, kx, ky, (C.EFFORT["GOALKEEP"] ?? 0.7) * C.EFFORT_SCALE, C.TICK_S, true);
      // 2. ボール
      const end = this.resolve(s, log);
      this.record();
      if (end !== null) {
        log.outcome = end;
        break;
      }
    }
    if (log.outcome === "TIME") this.log("時間切れ", s.attacker, "");
    // 🔑 終わったときに**攻めがいた場所**の価値。止められたシュートのボールはGKの手にあるので、ボールの場所では測らない
    log.endValue = placeValue(this.table, s.attacker.x, s.attacker.y);
    return log;
  }

  /** ボールの処理。終わったら終わり方を返す。 */
  private resolve(s: Scene, log: AttackLog): Outcome | null {
    const h = s.attacker;
    const opps = [s.defender, s.keeper];
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
        log.duelsWon += 1;
        this.contest_cd = C.TACKLE_COOLDOWN_TICKS;
      }
    }

    const act = this.attackPolicy.decide(s);
    if (act.kind === "SHOOT") {
      log.shots += 1;
      const dist = hypot(C.PITCH_X - h.x, C.PITCH_Y / 2 - h.y);
      const xg = Phys.expectedGoalAt(h, opps, C.PITCH_X, h.x, h.y, dist);
      if (this.rng.random() < xg) {
        this.ball_x = C.PITCH_X;
        this.ball_y = C.PITCH_Y / 2;
        this.owner = null;
        this.log("ゴール", h, `${fmtF(dist, 0)}m`);
        return "GOAL";
      }
      this.ball_x = s.keeper.x;
      this.ball_y = s.keeper.y;
      this.owner = s.keeper;
      this.log("シュート", h, `${fmtF(dist, 0)}m 枠外/セーブ`);
      return "SAVED";
    }
    log.dribbles += 1;
    // 運ぶ・抜く（11対11 の `dribble` と同じ式）
    const defender = Phys.opponentAhead(opps, h.x, h.y, h.x + act.dirX * 100.0, h.y + act.dirY * 100.0);
    if (defender !== null) {
      log.takeOns += 1;
      if (this.rng.random() >= Phys.dribbleChance(h, defender)) {
        return this.lose(defender, `${h.name} のドリブルを止めた`);
      }
      log.duelsWon += 1;
      log.takeOnsWon += 1;
    }
    const [nx, ny] = Phys.dribbleTarget(h, act.dirX, act.dirY);
    const stepLen = hypot(nx - h.x, ny - h.y);
    if (stepLen > 0) h.heading = atan2(ny - h.y, nx - h.x);
    h.x = nx;
    h.y = ny;
    h.stamina = Math.max(0.0, h.stamina - stepLen * C.STAMINA_DRAIN_PER_METER);
    this.ball_x = h.x;
    this.ball_y = h.y;
    if (!inside(this.area, h.x, h.y)) {
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

  private log(type: string, who: Actor, detail: string): void {
    if (!this.recording) return;
    const sec = Math.floor(this.tick * C.TICK_S);
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    // 🔑 得点の表示（試合の画面）はチーム名で数えるので、選手の名前をチーム名にする。
    //    tick はコマの番号（止めて見せるコマを含む）にそろえる
    this.events.push({ time: `${mm}:${ss}`, tick: this.frames.length, type, team: who.name,
                       player: who.name, detail });
  }

  /** 試合と同じ形のコマ（`Match.recordFrame`）。 */
  private record(): void {
    if (!this.recording) return;
    const k = C.REPLAY_COORD_SCALE;
    const frame = [pyRound(this.ball_x * k), pyRound(this.ball_y * k),
                   this.owner === null ? -1 : this.men.indexOf(this.owner)];
    for (const m of this.men) frame.push(pyRound(m.x * k), pyRound(m.y * k));
    this.frames.push(frame);
  }

  private replay(): Replay {
    const roster: RosterEntry[] = this.men.map((m) => ({ name: m.name, team: m.team_idx, pos: m.pos,
                                                         type: m.player.typeName }));
    return { sample_ticks: 1, tick_s: C.TICK_S, coord_scale: C.REPLAY_COORD_SCALE, pitch: [C.PITCH_X, C.PITCH_Y],
             roster, frames: this.frames,
             area: [this.area.x0, this.area.y0, this.area.x1, this.area.y1] };
  }
}

/** 練習を回す。 */
export function playArena(playerA: Player, playerB: Player, keeper: Player, seed: number,
                          attacks = C.ARENA_ATTACKS, opts: ArenaOptions = {}): ArenaResult {
  return new Arena(playerA, playerB, keeper, seed, opts).run(attacks);
}
