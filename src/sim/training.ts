/**
 * 特訓カードと課題（要件定義書 §8 ＋ 決定 D-02 / D-06）。
 *
 * 特訓は「見える能力」と「隠しパラメーター」を同時に動かす。
 * 隠しパラメーターが動くと `Player.typeName` が変わる（導出なので自動で追従する）。
 */

import { ValueError } from "./errors.ts";
import * as C from "./constants.ts";
import type { HiddenKey, VisibleKey } from "./constants.ts";
import type { Player, StatKey } from "./model.ts";

export interface Card {
  readonly key: string;
  readonly label: string;
  readonly visible_key: VisibleKey;
  readonly visible_gain: number;
  readonly hidden_key: HiddenKey;
  readonly hidden_gain: number;
  readonly issue: string;          // このカードがもらえる課題（表示用の文）
}

function card(key: string, label: string, visibleKey: VisibleKey, visibleGain: number,
              hiddenKey: HiddenKey, hiddenGain: number, issue: string): Card {
  return Object.freeze({
    key, label, visible_key: visibleKey, visible_gain: visibleGain,
    hidden_key: hiddenKey, hidden_gain: hiddenGain, issue,
  });
}

/** カード一覧。**並び順に意味がある**（画面の表示順・配分の入力順）。 */
export const CARDS: Readonly<Record<string, Card>> = {
  running: card("running", "ランニング", "stamina", 3, "overlap", 2,
                "スタミナが20%未満になった選手がいた"),
  man_mark: card("man_mark", "マンツーマン", "physical", 3, "zone_man", 4,
                 "奪い合いの負けが多い"),
  press: card("press", "プレス", "speed", 3, "press", 2,
              "ボール奪取が少ない"),
  pass: card("pass", "パス", "technique", 3, "support", 2,
             "パス成功率が低い"),
  dash: card("dash", "ダッシュ", "speed", 3, "run_space", 2,
             "裏を取られた・スピード負けが多い"),
  shoot: card("shoot", "シュート", "kick", 3, "goal_wait", 2,
              "シュート決定率が低い"),
  // D-02 で追加。スイーパーへの到達経路を作るためのカード。
  zone: card("zone", "ゾーン", "physical", 3, "zone_man", -4,
             "被シュートが多い"),
};

export const CARD_KEYS: readonly string[] = Object.keys(CARDS);

export function getCard(key: string): Card {
  const c = CARDS[key];
  if (c === undefined) throw new ValueError(`未知のカード: ${key}`);
  return c;
}

/** 2枚の組を順序なしで表す鍵（Python の frozenset の代わり）。 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}

// D-02: zone_man を打ち消し合うため同時使用を禁止する相反カード
export const FORBIDDEN_PAIRS: ReadonlySet<string> = new Set([pairKey("man_mark", "zone")]);

// D-06: スペシャルの名称。7枚の組み合わせは21種あるが、相反する1組（マンツーマン×ゾーン）は
// 名前を持たない＝20種。表に「NG」のような番人値を置くと、使う側が必ず判定を忘れる。
export const SPECIAL_NAMES: ReadonlyMap<string, string> = new Map([
  [pairKey("running", "man_mark"), "すっぽんマーク"],
  [pairKey("running", "press"), "鬼ごっこ"],
  [pairKey("running", "pass"), "二度追いパス"],
  [pairKey("running", "dash"), "無尽蔵"],
  [pairKey("running", "shoot"), "遅れてくる9番"],
  [pairKey("running", "zone"), "歩くスライドドア"],
  [pairKey("man_mark", "press"), "影踏み"],
  [pairKey("man_mark", "pass"), "奪って繋ぐ"],
  [pairKey("man_mark", "dash"), "背中を取らせない"],
  [pairKey("man_mark", "shoot"), "上がる番犬"],
  // man_mark × zone は相反のため名前を持たない（FORBIDDEN_PAIRS）
  [pairKey("press", "pass"), "刈り取りビルドアップ"],
  [pairKey("press", "dash"), "前へ出る本能"],
  [pairKey("press", "shoot"), "最前線の狩人"],
  [pairKey("press", "zone"), "押し上げる壁"],
  [pairKey("pass", "dash"), "呼吸で合わせる"],
  [pairKey("pass", "shoot"), "決める司令塔"],
  [pairKey("pass", "zone"), "拾って配る"],
  [pairKey("dash", "shoot"), "抜け出して沈める"],
  [pairKey("dash", "zone"), "走る最終ライン"],
  [pairKey("shoot", "zone"), "守ってカウンター"],
]);

export function specialName(cardA: string, cardB: string): string {
  if (cardA === cardB) throw new ValueError("スペシャルは違う2枚で作る");
  const pair = pairKey(cardA, cardB);
  if (FORBIDDEN_PAIRS.has(pair)) {
    throw new ValueError(
      `${getCard(cardA).label} と ${getCard(cardB).label} は相反するため同時に使えない（D-02）`);
  }
  const name = SPECIAL_NAMES.get(pair);
  if (name === undefined) throw new ValueError(`未知のカードの組: ${cardA}, ${cardB}`);
  return name;
}

/** スペシャルの倍率。小数切り捨て（負の値は絶対値を切り捨ててから符号を戻す）。 */
/**
 * 見える能力の伸び（D-43）。**伸びるほど伸びにくい**（69以下で満額、70〜84で-1、85以上で-2・最低1）。
 *
 * 🔴 伸びが一定だと、試合への効き方もほぼ比例なので「1枚に全部注ぐ」が必ず最善になる
 *    （プリセットが「スタミナ100・他は素人の40」になり、AIがその極端さを使い切って勝率 87% まで偏った）。
 *    逓減があって初めて「何を捨てて何を伸ばすか」に内側の最適が生まれる（オーナー指摘 2026-10-04）。
 * 🔑 隠しパラメーターは逓減させない。タイプの変わり方（3〜10回・D-03）を守るため。
 */
export function visibleGain(current: number, cardGain: number): number {
  let cut = 0;
  for (const [from, c] of C.TRAINING_DIMINISH) if (current >= from) cut = c;
  return Math.max(1, cardGain - cut);
}

function scaled(gain: number): number {
  const v = Math.floor(Math.abs(gain) * C.SPECIAL_MULTIPLIER);
  return gain < 0 ? -v : v;
}

export interface TrainingResult {
  label: string;
  before: string;
  after: string;
  deltas: Record<string, number>;
}

/**
 * 特訓を1回適用する。1枚なら通常、2枚ならスペシャル（両方1.5倍・切り捨て）。
 *
 * 戻り値は {label: 表示名, before: タイプ, after: タイプ, deltas: {...}}。
 */
export function applyTraining(player: Player, cards: readonly string[]): TrainingResult {
  if (!(cards.length >= 1 && cards.length <= 2)) {
    throw new ValueError("特訓は1枚（通常）か2枚（スペシャル）");
  }
  for (const key of cards) {
    if (!(key in CARDS)) throw new ValueError(`未知のカード: ${key}`);
  }

  const special = cards.length === 2;
  const label = special ? specialName(cards[0]!, cards[1]!) : getCard(cards[0]!).label;

  const before = player.typeName;
  // 🔑 Python の dict と同じく「最初に出てきた順」で並べる（画面の表示順になる）
  const deltas: Record<string, number> = {};
  for (const key of cards) {
    const c = getCard(key);
    const gain = visibleGain(player.get(c.visible_key), c.visible_gain);
    const vg = special ? scaled(gain) : gain;
    const hg = special ? scaled(c.hidden_gain) : c.hidden_gain;
    deltas[c.visible_key] = (deltas[c.visible_key] ?? 0) + vg;
    deltas[c.hidden_key] = (deltas[c.hidden_key] ?? 0) + hg;
  }

  for (const [k, v] of Object.entries(deltas)) {
    player.set(k as StatKey, player.get(k as StatKey) + v);
  }
  player.clamp();

  return { label, before, after: player.typeName, deltas };
}

// ------------------------------------------------------------------ 課題発見

export interface IssueStats {
  stamina_low_players?: number;
  duels?: number;
  duels_lost?: number;
  tackles_won?: number;
  passes?: number;
  passes_completed?: number;
  beaten_behind?: number;
  shots?: number;
  goals?: number;
  shots_against?: number;
}

/**
 * 1試合のチームスタッツから課題（＝もらえるカード）を求める。
 *
 * 同じ課題は1試合で1回まで、最大 TRAINING_MAX_CARDS_PER_MATCH 枚（§8）。
 * 判定順は固定（決定論のため）。
 */
export function findIssues(s: IssueStats): string[] {
  const issues: string[] = [];
  const add = (cardKey: string): void => {
    if (!issues.includes(cardKey) && issues.length < C.TRAINING_MAX_CARDS_PER_MATCH) {
      issues.push(cardKey);
    }
  };

  if ((s.stamina_low_players ?? 0) > 0) add("running");

  const duels = s.duels ?? 0;
  if (duels >= C.ISSUE_DUEL_MIN_SAMPLES) {
    const lost = s.duels_lost ?? 0;
    if (lost / duels >= C.ISSUE_DUEL_LOSS_RATE) add("man_mark");
  }

  if ((s.tackles_won ?? 0) < C.ISSUE_TACKLES_WON_MIN) add("press");

  const passes = s.passes ?? 0;
  // 🔑 件数の門番を先に置く（0除算と、少ない試行での過剰反応の両方を防ぐ）
  if (passes >= C.ISSUE_PASS_MIN_SAMPLES
      && (s.passes_completed ?? 0) / passes < C.ISSUE_PASS_SUCCESS_RATE) {
    add("pass");
  }

  if ((s.beaten_behind ?? 0) > C.ISSUE_BEATEN_BEHIND_MAX) add("dash");

  const shots = s.shots ?? 0;
  if (shots >= C.ISSUE_SHOT_MIN_SAMPLES && (s.goals ?? 0) / shots < C.ISSUE_SHOT_CONVERSION) {
    add("shoot");
  }

  if ((s.shots_against ?? 0) > C.ISSUE_SHOTS_AGAINST_MAX) add("zone");

  return issues;
}

export function issueText(cardKey: string): string {
  const c = getCard(cardKey);
  return `${c.issue} → 「${c.label}」`;
}
