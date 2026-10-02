/**
 * 選手・チーム・戦術のデータ構造とタイプ判定。
 *
 * タイプは隠しパラメーターから**毎回導出する**（決定 D-07）。
 * 保存すると「隠しパラメーターを動かしたのにタイプが古いまま」という故障の形が生まれる。
 */

import { ValueError } from "./errors.ts";
import * as C from "./constants.ts";
import type { HiddenKey, TraitKey, VisibleKey } from "./constants.ts";

export const POSITIONS = ["GK", "DF", "MF", "FW"] as const;
export type Position = (typeof POSITIONS)[number];

export type Hidden = Record<HiddenKey, number>;
export type Visible = Record<VisibleKey, number>;
export type Traits = Record<TraitKey, number>;
/** 特訓で動かせる値（見える能力＋隠しパラメーター）。 */
export type StatKey = VisibleKey | HiddenKey;

// ---------------------------------------------------------------- タイプ判定

/** 攻撃系4種を降順に並べる。同値は D-04 の固定順で決める。 */
function rankedAttack(hidden: Hidden): [string, number][] {
  const order = new Map<string, number>(C.ATTACK_TIE_BREAK.map((k, i) => [k, i]));
  return C.ATTACK_HIDDEN_KEYS
    .map((k): [string, number] => [k, hidden[k]])
    .sort((a, b) => (b[1] - a[1]) || (order.get(a[0])! - order.get(b[0])!));
}

// D-10: 攻撃系の最大値がどれかだけで決めるときの対応表
const SINGLE_TOP_TYPE: Readonly<Record<string, string>> = {
  goal_wait: "ストライカー",
  run_space: "アタッカー",
  overlap: "ダイナモ",
  support: "レジスタ",
};

function samePair(a: string, b: string, x: string, y: string): boolean {
  return (a === x && b === y) || (a === y && b === x);
}

/**
 * 隠しパラメーターからタイプを決める（要件定義書 §7 ＋ 決定 D-01〜D-05）。
 *
 * 上から順に判定し、最初に当てはまったものを返す。
 */
export function judgeType(hidden: Hidden): string {
  const th = C.TYPE_THRESHOLD;
  const ranked = rankedAttack(hidden);
  const attackMax = ranked[0]![1];
  const press = hidden.press;
  const zoneMan = hidden.zone_man;

  // 1. 何も伸びていない → バランス（D-01 で |zone_man| を条件に追加）
  if (attackMax < th && press < th && Math.abs(zoneMan) < th) return "バランス";

  // 攻撃タイプの門（D-04）: 攻撃側が育っていないうちは同値判定に入らない
  if (attackMax >= th) {
    const [top1, top2] = [ranked[0]!, ranked[1]!];
    // 2. ストライカー
    if (top1[0] === "goal_wait" && top1[1] - top2[1] >= C.STRIKER_MARGIN) return "ストライカー";
    // 3. アタッカー
    if (samePair(top1[0], top2[0], "run_space", "goal_wait")) return "アタッカー";
    // 4. ダイナモ
    if (samePair(top1[0], top2[0], "overlap", "run_space")) return "ダイナモ";
    // 5. レジスタ
    if (top1[0] === "support") return "レジスタ";
    // 5b. 上位2つの組み合わせが表に無い場合は、最も高い1つで決める（決定 D-10）。
    //     §7 の8ルールは {overlap, support} {overlap, goal_wait} {run_space, support}
    //     {support, goal_wait} を覆っていない。スペシャル特訓は2つの攻撃系を
    //     同じだけ上げるので、この穴に落ちると永久にバランスのままになる
    //     （実測: パス＋ランニング等4組が20回でタイプが変わらなかった）。
    return SINGLE_TOP_TYPE[top1[0]]!;
  }

  // 守備タイプ
  if (zoneMan >= th && press >= C.STOPPER_PRESS) return "ストッパー";   // §7-7
  if (zoneMan >= th) return "マンマーカー";                             // D-01 で新設
  if (zoneMan <= -th && press < C.STOPPER_PRESS) return "スイーパー";  // §7-6（D-02 で到達可能になった）
  if (press >= th) return "プレッサー";                                 // D-01 で新設

  return "バランス";
}

// -------------------------------------------------------------------- 選手

export interface PlayerData {
  name: string;
  position: string;
  kick?: number;
  speed?: number;
  stamina?: number;
  technique?: number;
  physical?: number;
  zone_man?: number;
  press?: number;
  support?: number;
  overlap?: number;
  run_space?: number;
  goal_wait?: number;
  cover_range?: number;
  vision_range?: number;
}

const PLAYER_KEYS = new Set<string>([
  "name", "position", ...C.VISIBLE_KEYS, ...C.HIDDEN_KEYS, ...C.TRAIT_KEYS,
]);

export class Player {
  name: string;
  position: Position;
  kick = 50;
  speed = 50;
  stamina = 50;
  technique = 50;
  physical = 50;
  zone_man = 0;
  press = 10;
  support = 10;
  overlap = 10;
  run_space = 10;
  goal_wait = 10;

  // --- 生まれ持った性質（特訓で動かない・D-11） ---------------------
  // 🔴 タイプ判定にも特訓にも関与しない。`hidden` には入れないこと
  cover_range = 50;            // 持ち場からどこまで出て仕事をするか
  vision_range = 50;           // どこまで見えているか＝何に反応するか

  constructor(data: PlayerData) {
    if (!(POSITIONS as readonly string[]).includes(data.position)) {
      throw new ValueError(`未知のポジション: ${data.position}`);
    }
    this.name = data.name;
    this.position = data.position as Position;
    for (const k of [...C.VISIBLE_KEYS, ...C.HIDDEN_KEYS, ...C.TRAIT_KEYS]) {
      const v = data[k];
      if (v !== undefined) this[k] = v;
    }
  }

  get(key: StatKey | TraitKey): number {
    return this[key];
  }

  set(key: StatKey | TraitKey, value: number): void {
    this[key] = value;
  }

  // --- 導出値（保存しない。D-07） -------------------------------------
  get hidden(): Hidden {
    return {
      zone_man: this.zone_man, press: this.press, support: this.support,
      overlap: this.overlap, run_space: this.run_space, goal_wait: this.goal_wait,
    };
  }

  /** 生まれ持った性質。**特訓で動かないので `hidden` とは別に出す。** */
  get traits(): Traits {
    return { cover_range: this.cover_range, vision_range: this.vision_range };
  }

  /** 持ち場からこの距離までを自分の受け持ちだと思っている。 */
  get roamM(): number {
    const t = this.cover_range / 100.0;
    return C.ROAM_MIN_M + t * (C.ROAM_MAX_M - C.ROAM_MIN_M);
  }

  /** この距離までが見えている＝反応できる。 */
  get visionM(): number {
    const t = this.vision_range / 100.0;
    return C.VISION_MIN_M + t * (C.VISION_MAX_M - C.VISION_MIN_M);
  }

  /** 持ち場を守っている間、play にどれだけ位置を合わせ直すか。 */
  get holdTrack(): number {
    const t = this.cover_range / 100.0;
    return C.HOLD_TRACK_MIN + t * (C.HOLD_TRACK_MAX - C.HOLD_TRACK_MIN);
  }

  /** 持ち場を守るときの本気度の倍率。広い選手ほど歩かない。 */
  get roamEffort(): number {
    const t = this.cover_range / 100.0;
    return C.ROAM_EFFORT_MIN + t * (C.ROAM_EFFORT_MAX - C.ROAM_EFFORT_MIN);
  }

  get visible(): Visible {
    return {
      kick: this.kick, speed: this.speed, stamina: this.stamina,
      technique: this.technique, physical: this.physical,
    };
  }

  get typeName(): string {
    return judgeType(this.hidden);
  }

  /**
   * 試合中に使える体力の総量。stamina 能力が高いほど大きい。
   *
   * 幅を広く取っているのは、stamina が「疲れにくさ」以外に何の効果も持たないため。
   * ここが狭いと、ランニング特訓（stamina+3）がほぼ無価値になる。
   */
  get maxStamina(): number {
    return C.STAMINA_BASE + this.stamina * C.STAMINA_PER_POINT;
  }

  /** 上限・下限に収める（要件定義書 §8「上限は100」）。 */
  clamp(): void {
    for (const k of C.VISIBLE_KEYS) {
      this[k] = Math.max(C.ABILITY_MIN, Math.min(C.ABILITY_MAX, Math.trunc(this[k])));
    }
    for (const k of [...C.ATTACK_HIDDEN_KEYS, "press"] as const) {
      this[k] = Math.max(0, Math.min(C.HIDDEN_MAX, Math.trunc(this[k])));
    }
    this.zone_man = Math.max(C.ZONE_MAN_MIN, Math.min(C.ZONE_MAN_MAX, Math.trunc(this.zone_man)));
  }

  /** 保存する形。キーの順は Python 版と同じ（見える能力 → 隠し → 性質）。 */
  toDict(): Required<PlayerData> {
    return {
      name: this.name, position: this.position,
      ...this.visible, ...this.hidden, ...this.traits,
    };
  }

  static fromDict(d: Record<string, unknown>): Player {
    const unknown = Object.keys(d).filter((k) => !PLAYER_KEYS.has(k)).sort();
    if (unknown.length > 0) {
      // 「type」が書かれていたら D-07 違反なので落とす
      throw new ValueError(`選手 ${String(d.name)} に未知のキー: ${JSON.stringify(unknown)}`);
    }
    for (const k of PLAYER_KEYS) {
      if (k === "name" || k === "position") {
        if (typeof d[k] !== "string") throw new ValueError(`選手の ${k} が文字列でない`);
      } else if (d[k] !== undefined && typeof d[k] !== "number") {
        throw new ValueError(`選手 ${String(d.name)} の ${k} が数でない`);
      }
    }
    return new Player(d as unknown as PlayerData);
  }

  /** 同じ値を持つ別の選手（試合ごとに状態を持ち込まないための複製）。 */
  clone(): Player {
    return new Player(this.toDict());
  }
}

// ------------------------------------------------------------- 戦術・方針

/** (ポジション, x_frac: 0=自ゴール 1=相手ゴール, y_frac: 0=下 1=上) */
export type Slot = readonly [Position, number, number];

export const FORMATIONS: Readonly<Record<string, readonly Slot[]>> = {
  "4-4-2": [
    ["GK", 0.04, 0.50],
    ["DF", 0.20, 0.14], ["DF", 0.19, 0.38], ["DF", 0.19, 0.62], ["DF", 0.20, 0.86],
    ["MF", 0.44, 0.14], ["MF", 0.42, 0.38], ["MF", 0.42, 0.62], ["MF", 0.44, 0.86],
    ["FW", 0.70, 0.38], ["FW", 0.70, 0.62],
  ],
  "3-5-2": [
    ["GK", 0.04, 0.50],
    ["DF", 0.19, 0.28], ["DF", 0.18, 0.50], ["DF", 0.19, 0.72],
    ["MF", 0.46, 0.10], ["MF", 0.40, 0.32], ["MF", 0.38, 0.50],
    ["MF", 0.40, 0.68], ["MF", 0.46, 0.90],
    ["FW", 0.70, 0.40], ["FW", 0.70, 0.60],
  ],
  "4-5-1": [
    ["GK", 0.04, 0.50],
    ["DF", 0.19, 0.14], ["DF", 0.18, 0.38], ["DF", 0.18, 0.62], ["DF", 0.19, 0.86],
    ["MF", 0.44, 0.12], ["MF", 0.40, 0.32], ["MF", 0.38, 0.50],
    ["MF", 0.40, 0.68], ["MF", 0.44, 0.88],
    ["FW", 0.72, 0.50],
  ],
  "3-4-3": [
    ["GK", 0.04, 0.50],
    ["DF", 0.20, 0.28], ["DF", 0.19, 0.50], ["DF", 0.20, 0.72],
    ["MF", 0.46, 0.16], ["MF", 0.43, 0.40], ["MF", 0.43, 0.60], ["MF", 0.46, 0.84],
    ["FW", 0.72, 0.20], ["FW", 0.74, 0.50], ["FW", 0.72, 0.80],
  ],
};

export const ATTITUDES = ["守備的", "バランス", "攻撃的"] as const;

export const POLICY_CONDITIONS = [
  "LEADING_LATE", "TRAILING_LATE", "OPP_GK_WEAK_KICK", "OPP_HIGH_LINE", "OWN_STAMINA_LOW",
] as const;
export const POLICY_ACTIONS = [
  "LINE_DOWN", "PUSH_UP", "HIGH_PRESS", "THROUGH_BALLS", "LESS_PRESS",
] as const;

export class PolicyRule {
  readonly condition: string;
  readonly action: string;

  constructor(condition: string, action: string) {
    if (!(POLICY_CONDITIONS as readonly string[]).includes(condition)) {
      throw new ValueError(`未知の条件: ${condition}`);
    }
    if (!(POLICY_ACTIONS as readonly string[]).includes(action)) {
      throw new ValueError(`未知の行動: ${action}`);
    }
    this.condition = condition;
    this.action = action;
  }
}

export interface ManagerData {
  style?: number;
  rigidity?: number;
  substitution?: number;
  selection?: number;
}

/** 監督の性格スライダー（各 -2〜+2）。 */
export class Manager {
  style: number;          // 守備的↔攻撃的
  rigidity: number;       // 弾力的↔徹底的
  substitution: number;   // 消極的↔積極的
  selection: number;      // 安定感↔期待感（MVPでは値のみ保持・処理なし §10）

  constructor(d: ManagerData = {}) {
    this.style = d.style ?? 0;
    this.rigidity = d.rigidity ?? 0;
    this.substitution = d.substitution ?? 0;
    this.selection = d.selection ?? 0;
    for (const k of ["style", "rigidity", "substitution", "selection"] as const) {
      const v = this[k];
      if (typeof v !== "number" || !(v >= -2 && v <= 2)) {
        throw new ValueError(`スライダー ${k} は -2〜+2: ${v}`);
      }
    }
  }
}

export interface TacticsData {
  line_height?: number;
  zone_width?: number;
  attitude?: string;
  formation?: string;
}

export class Tactics {
  line_height: number;
  zone_width: number;
  attitude: string;
  formation: string;

  constructor(d: TacticsData = {}) {
    this.line_height = d.line_height ?? 3;
    this.zone_width = d.zone_width ?? 3;
    this.attitude = d.attitude ?? "バランス";
    this.formation = d.formation ?? "4-4-2";
    if (!(this.line_height >= 1 && this.line_height <= 5)) {
      throw new ValueError(`line_height は 1〜5: ${this.line_height}`);
    }
    if (!(this.zone_width >= 1 && this.zone_width <= 5)) {
      throw new ValueError(`zone_width は 1〜5: ${this.zone_width}`);
    }
    if (!(ATTITUDES as readonly string[]).includes(this.attitude)) {
      throw new ValueError(`未知の attitude: ${this.attitude}`);
    }
    if (!(this.formation in FORMATIONS)) {
      throw new ValueError(`未知のフォーメーション: ${this.formation}`);
    }
  }
}

export interface TeamData {
  name: string;
  players: Record<string, unknown>[];
  bench?: Record<string, unknown>[];
  tactics?: TacticsData;
  policy?: { condition: string; action: string }[];
  manager?: ManagerData;
}

export interface TeamInit {
  name: string;
  players: Player[];
  bench?: Player[];
  tactics?: Tactics;
  policy?: PolicyRule[];
  manager?: Manager;
}

function rejectUnknown(label: string, obj: object | undefined, allowed: string[]): void {
  if (obj === undefined) return;
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new ValueError(`${label} に未知のキー: ${JSON.stringify(extra.sort())}`);
}

export class Team {
  name: string;
  players: Player[];                      // 先発11人
  bench: Player[];
  tactics: Tactics;
  policy: PolicyRule[];
  manager: Manager;

  constructor(init: TeamInit) {
    this.name = init.name;
    this.players = init.players;
    this.bench = init.bench ?? [];
    this.tactics = init.tactics ?? new Tactics();
    this.policy = init.policy ?? [];
    this.manager = init.manager ?? new Manager();
    if (this.players.length !== C.PLAYERS_ON_PITCH) {
      throw new ValueError(`${this.name}: 先発は11人（今 ${this.players.length}人）`);
    }
    if (this.bench.length > C.BENCH_SIZE) {
      throw new ValueError(`${this.name}: 控えは最大${C.BENCH_SIZE}人`);
    }
    if (this.policy.length > C.POLICY_MAX_RULES) {
      throw new ValueError(`${this.name}: チーム方針は最大${C.POLICY_MAX_RULES}個`);
    }
    if (this.players.filter((p) => p.position === "GK").length !== 1) {
      throw new ValueError(`${this.name}: 先発のGKは1人でなければならない`);
    }
  }

  get allPlayers(): Player[] {
    return [...this.players, ...this.bench];
  }

  abilityTotal(): number {
    let total = 0;
    for (const p of this.allPlayers) {
      for (const v of Object.values(p.visible)) total += v;
    }
    return total;
  }

  toDict(): Required<TeamData> & { players: Required<PlayerData>[]; bench: Required<PlayerData>[] } {
    return {
      name: this.name,
      tactics: {
        line_height: this.tactics.line_height,
        zone_width: this.tactics.zone_width,
        attitude: this.tactics.attitude,
        formation: this.tactics.formation,
      },
      policy: this.policy.map((r) => ({ condition: r.condition, action: r.action })),
      manager: {
        style: this.manager.style,
        rigidity: this.manager.rigidity,
        substitution: this.manager.substitution,
        selection: this.manager.selection,
      },
      players: this.players.map((p) => p.toDict()),
      bench: this.bench.map((p) => p.toDict()),
    };
  }

  static fromDict(d: TeamData): Team {
    // 🔑 Python 版は `Tactics(**d)` で、知らない鍵があれば落ちていた。同じ厳しさにする
    rejectUnknown("tactics", d.tactics, ["line_height", "zone_width", "attitude", "formation"]);
    rejectUnknown("manager", d.manager, ["style", "rigidity", "substitution", "selection"]);
    for (const r of d.policy ?? []) rejectUnknown("policy", r, ["condition", "action"]);
    return new Team({
      name: d.name,
      players: d.players.map((p) => Player.fromDict(p)),
      bench: (d.bench ?? []).map((p) => Player.fromDict(p)),
      tactics: new Tactics(d.tactics ?? {}),
      policy: (d.policy ?? []).map((r) => new PolicyRule(r.condition, r.action)),
      manager: new Manager(d.manager ?? {}),
    });
  }

  /** 試合ごとに状態を持ち込まないための丸ごとの複製（Python の deepcopy）。 */
  clone(): Team {
    return Team.fromDict(this.toDict());
  }
}
