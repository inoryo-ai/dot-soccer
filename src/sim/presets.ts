/**
 * プリセット6チームの生成（要件定義書 §11）。
 *
 * 「同じ初期能力の選手に違う特訓を20回ずつ行って作る。能力合計はほぼそろえる。」
 * 初期値をすべて40にしているのは、特訓20回（+3×20=+60）で**ちょうど100に届き、
 * 上限で切られない**ため。切られると能力合計がチーム間でずれて比較が成立しない。
 */

import { RuntimeError, ValueError } from "./errors.ts";
import * as C from "./constants.ts";
import { Manager, Player, PolicyRule, Tactics, Team } from "./model.ts";
import type { Position } from "./model.ts";
import { PyRandom } from "./pyrandom.ts";
import { applyTraining } from "./training.ts";

export const TRAININGS_PER_PLAYER = 20;

// 4-4-2 の枠に合わせた編成（先発11＋控え5）
export const SQUAD: readonly (readonly [Position, number])[] = [
  ["GK", 1], ["DF", 4], ["MF", 4], ["FW", 2],          // 先発
];
export const BENCH: readonly (readonly [Position, number])[] = [
  ["GK", 1], ["DF", 1], ["MF", 2], ["FW", 1],          // 控え5
];

const FIELD_BASE = { kick: 40, speed: 40, stamina: 40, technique: 40, physical: 40 };
const GK_BASE = { kick: 45, speed: 45, stamina: 45, technique: 50, physical: 50 };

/** 特訓の配分（カード → 回数）。**並び順に意味がある**（特訓する順）。 */
export type Plan = Record<string, number>;
export type PresetPlan = readonly [Plan, readonly (readonly [string, string])[]];

// チーム名 → (特訓の配分, チーム方針)
export const PRESET_PLANS: Readonly<Record<string, PresetPlan>> = {
  "走力型": [{ running: 20 }, []],
  "プレス型": [{ press: 20 }, [["OPP_GK_WEAK_KICK", "HIGH_PRESS"]]],
  "パス型": [{ pass: 20 }, []],
  "裏抜け型": [{ dash: 20 }, [["OPP_HIGH_LINE", "THROUGH_BALLS"]]],
  "堅守型": [{ man_mark: 20 }, [["LEADING_LATE", "LINE_DOWN"]]],
  // 全カード均等（7枚で20回 → 3,3,3,3,3,3,2）。マンツーマンとゾーンが打ち消し合うので
  // zone_man は伸びず、狙いどおり「バランス」で止まる。
  "バランス型": [{ running: 3, man_mark: 3, press: 3, pass: 3, dash: 3, shoot: 3, zone: 2 }, []],
};

export const PRESET_ORDER: readonly string[] = Object.keys(PRESET_PLANS);

// リーグ用の追加チーム。要件定義書 §11 のプリセット表は6チームなので、
// `batch` の勝率表（提出済みの成果物）は PRESET_ORDER の6チームのまま変えない。
// リーグは偶数チームでなければ日程が組めないため、対戦相手として7チーム目を足す。
export const EXTRA_PRESET_PLANS: Readonly<Record<string, PresetPlan>> = {
  "シュート型": [{ shoot: 20 }, [["TRAILING_LATE", "PUSH_UP"]]],
};
export const ALL_PRESET_PLANS: Readonly<Record<string, PresetPlan>> = {
  ...PRESET_PLANS, ...EXTRA_PRESET_PLANS,
};
// 自チーム＋この7チーム＝8チーム（偶数）でリーグを組む
export const LEAGUE_OPPONENTS: readonly string[] = [
  ...PRESET_ORDER, ...Object.keys(EXTRA_PRESET_PLANS),
];

function presetPlan(name: string): PresetPlan {
  const p = ALL_PRESET_PLANS[name];
  if (p === undefined) {
    throw new ValueError(`未知のプリセット: ${name}（使えるのは ${Object.keys(ALL_PRESET_PLANS).join(", ")}）`);
  }
  return p;
}

/** チームの特訓配分を、カードを回数分並べた列にする（AIの成長に使う）。 */
export function planCardSequence(name: string): string[] {
  const seq: string[] = [];
  for (const [cardKey, times] of Object.entries(presetPlan(name)[0])) {
    for (let i = 0; i < times; i++) seq.push(cardKey);
  }
  return seq;
}

// AIチームの伸びる方向。列の順にカードを消費していくので、シーズンをまたいで
// 配分どおりに育つ（1シーズン目だけ偏る、ということが起きない）。
export const ALL_PLAN_CARDS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.keys(ALL_PRESET_PLANS).map((name) => [name, planCardSequence(name)]),
);

function makePlayer(team: string, pos: Position, n: number): Player {
  const base = pos === "GK" ? GK_BASE : FIELD_BASE;
  return new Player({ name: `${team}${pos}${n}`, position: pos, ...base });
}

function squadOf(teamName: string): [Player[], Player[]] {
  const starters: Player[] = [];
  for (const [pos, count] of SQUAD) {
    for (let i = 1; i <= count; i++) starters.push(makePlayer(teamName, pos, i));
  }
  const bench: Player[] = [];
  for (const [pos, count] of BENCH) {
    for (let i = 1; i <= count; i++) bench.push(makePlayer(teamName, pos, 90 + i));
  }
  return [starters, bench];
}

/** 配分どおりに特訓する。GKは特訓しない（プリセットの差は field player で作る）。 */
function train(players: Player[], plan: Plan): void {
  const total = Object.values(plan).reduce((a, b) => a + b, 0);
  if (total !== TRAININGS_PER_PLAYER) {
    throw new ValueError(`特訓の合計が${TRAININGS_PER_PLAYER}回でない: ${total}`);
  }
  for (const p of players) {
    if (p.position === "GK") continue;
    for (const [cardKey, times] of Object.entries(plan)) {
      for (let i = 0; i < times; i++) applyTraining(p, [cardKey]);
    }
  }
}

export function buildPreset(name: string): Team {
  const [plan, policy] = presetPlan(name);
  const [starters, bench] = squadOf(name);
  train(starters, plan);
  train(bench, plan);
  // 🔴 AIチームにも生まれ持った性質を配る。プレイヤー側だけに配ると、
  //    「走り回る選手」が自チームにしか存在しない盤面になる。
  // 🔑 チーム名から導いた固定の種を使う。`data/*.json` に書き出すので、
  //    呼ぶたびに変わると保存済みのプリセットと食い違う
  const traitRng = new PyRandom(`traits:${name}`);
  for (const p of [...starters, ...bench]) giveTraits(p, traitRng);
  return new Team({
    name,
    players: starters,
    bench,
    tactics: new Tactics({ line_height: 3, zone_width: 3, attitude: "バランス", formation: "4-4-2" }),
    policy: policy.map(([c, a]) => new PolicyRule(c, a)),
    manager: new Manager(),
  });
}

export function buildAll(): Team[] {
  return PRESET_ORDER.map((n) => buildPreset(n));
}

/** `data/` に書き出すファイル名の素（プリセット名 → 英字）。 */
export const PRESET_SLUGS: Readonly<Record<string, string>> = {
  "走力型": "runner", "プレス型": "presser", "パス型": "passer",
  "裏抜け型": "breaker", "堅守型": "defender", "バランス型": "balanced",
};

/** `data/` に書き出すチーム一式（ファイル名 → チーム）。 */
export function dataFileTeams(): [string, Team][] {
  const out: [string, Team][] = buildAll().map((t) => [`preset_${PRESET_SLUGS[t.name]!}.json`, t]);
  // 1試合コマンドの既定の相手
  const a = buildPreset("バランス型");
  a.name = "バランスFC";
  out.push(["team_a.json", a]);
  const b = buildPreset("プレス型");
  b.name = "プレスユナイテッド";
  out.push(["team_b.json", b]);
  return out;
}

/** 能力合計がそろっているかを確認するための値。 */
export function abilityTotals(): Record<string, number> {
  return Object.fromEntries(buildAll().map((t) => [t.name, t.abilityTotal()]));
}

const SURNAMES = ["東雲", "柊", "鷺沢", "巴", "九条", "鳴海", "白瀬", "灰島", "御堂", "藤守",
                  "相楽", "凪原", "犬飼", "月峯", "蓮見", "遠野", "神楽坂", "碧井"];
const GIVEN_NAMES = ["陸", "奏", "翔太", "涼", "颯", "悠真", "壱", "拓実", "岳", "湊",
                     "蒼真", "柚希", "叶", "隼", "礼", "空", "楓", "怜"];

// 個性の付け方: 合計を変えずに配分だけ動かす。足したり引いたりすると、
// 自チームだけ能力合計が違う＝勝率の比較が成立しなくなる。
const PERSONALITY_SWAPS = 6;       // ±1 の入れ替え回数
const PERSONALITY_RANGE = 6;       // 初期値からこれ以上離れない

/**
 * 生まれ持った性質（カバー範囲・視野範囲）を決める。
 *
 * 🔴 **特訓で動かない値なので、ここでしか決まらない。**
 *    AIチームもプレイヤーのチームも同じ関数を通す。片方だけ通すと、
 *    「走り回る選手」が片方のチームにしか生まれない。
 *
 * 🔑 ポジションの寄り（`TRAIT_BIAS`）＋個人の振れ。
 *    DFは持ち場を空けにくく、MFは走り回る、という**傾向**は付けるが、
 *    個人の振れのほうを大きくして「その枠らしくない選手」も生まれるようにする。
 */
function giveTraits(player: Player, rng: PyRandom): void {
  const bias = C.TRAIT_BIAS[player.position]!;
  for (const key of C.TRAIT_KEYS) {
    const value = 50 + bias[key] + rng.randint(-28, 28);
    player.set(key, Math.max(C.TRAIT_MIN, Math.min(C.TRAIT_MAX, value)));
  }
}

/**
 * 見える能力の配分を少し動かす。合計は変えない。
 *
 * 🔴 **特訓のあとに呼ぶこと。** 先に動かすと、+60される能力が 46 から始まって
 * 106 になり、上限100で切られて能力合計が減る（チーム間の比較が成立しなくなる）。
 * 上限・下限に当たる入れ替えは行わないので、合計は厳密に保たれる。
 */
function personalize(player: Player, rng: PyRandom): void {
  const keys = [...C.VISIBLE_KEYS];
  const shift: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (let i = 0; i < PERSONALITY_SWAPS; i++) {
    const [up, down] = rng.sample(keys, 2) as [typeof keys[number], typeof keys[number]];
    if (player.get(up) >= C.ABILITY_MAX || player.get(down) <= C.ABILITY_MIN) continue;
    if (shift[up]! >= PERSONALITY_RANGE || shift[down]! <= -PERSONALITY_RANGE) continue;
    player.set(up, player.get(up) + 1);
    player.set(down, player.get(down) - 1);
    shift[up]! += 1;
    shift[down]! -= 1;
  }
}

/** 初期育成のおすすめ配分（バランス型と同じ）。 */
export function defaultUserPlan(): Plan {
  return { ...PRESET_PLANS["バランス型"]![0] };
}

/**
 * プレイヤーの初期チーム。
 *
 * 🔴 **AIプリセットと同じ「特訓20回」を必ず受けてから始める。**
 * これをしないと、AIは20回ぶん（+60/人・チーム合計+840）育った状態なのに
 * プレイヤーだけ素の状態で開幕することになる（実測: 自3270 / AI4110）。
 * 配分をプレイヤーが決めることが、このゲームの最初の選択そのもの。
 */
export function buildUserTeam(teamName: string, seed: number, formation = "4-4-2",
                              plan: Plan | null = null): Team {
  const rng = new PyRandom(seed);
  const used = new Set<string>();

  const make = (pos: Position): Player => {
    let name: string | null = null;
    for (let i = 0; i < 200; i++) {
      const candidate = `${rng.choice(SURNAMES)} ${rng.choice(GIVEN_NAMES)}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        name = candidate;
        break;
      }
    }
    if (name === null) throw new RuntimeError("選手名の候補が足りない");
    const base = pos === "GK" ? GK_BASE : FIELD_BASE;
    return new Player({ name, position: pos, ...base });
  };

  const starters: Player[] = [];
  for (const [pos, count] of SQUAD) for (let i = 0; i < count; i++) starters.push(make(pos));
  const bench: Player[] = [];
  for (const [pos, count] of BENCH) for (let i = 0; i < count; i++) bench.push(make(pos));
  const chosen = plan === null ? defaultUserPlan() : { ...plan };
  train(starters, chosen);          // 合計が20回でなければここで落ちる
  train(bench, chosen);
  for (const p of [...starters, ...bench]) {   // 個性は特訓のあとに付ける（上限で切られないように）
    personalize(p, rng);
    giveTraits(p, rng);             // 生まれ持った性質（特訓では動かない）
  }
  return new Team({ name: teamName, players: starters, bench,
                    tactics: new Tactics({ formation }) });
}

/** 特訓が上限で切られなかった場合の能力合計（全チームで同じ値になるはず）。 */
export function expectedAbilityTotal(): number {
  const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);
  const gkTotal = sum(GK_BASE);
  const fieldTotal = sum(FIELD_BASE) + C.VISIBLE_GAIN * TRAININGS_PER_PLAYER;
  const all = [...SQUAD, ...BENCH];
  const nGk = all.filter(([pos]) => pos === "GK").reduce((a, [, c]) => a + c, 0);
  const nField = all.filter(([pos]) => pos !== "GK").reduce((a, [, c]) => a + c, 0);
  return gkTotal * nGk + fieldTotal * nField;
}

/** 上限100で切られていないか。切られると能力合計がずれて、チーム比較が成立しない。 */
export function checkNoClamping(): string[] {
  const expected = expectedAbilityTotal();
  const problems: string[] = [];
  for (const [name, total] of Object.entries(abilityTotals())) {
    if (total !== expected) {
      problems.push(`${name}: 能力合計 ${total}（期待 ${expected}）＝上限で切られている`);
    }
  }
  return problems;
}
