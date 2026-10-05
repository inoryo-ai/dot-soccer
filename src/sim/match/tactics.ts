/**
 * 戦術のつまみ（D-42・2026-10-05 オーナー判断「ここからは戦術の調整として考える」）。
 *
 * 🔑 守り方・攻め方の**部品**（陣形を詰める・塞ぐ・寄せる・走り込む…）はエンジンに置き、
 *    **どれだけ使うか**をチームごとのこの設定で決める。プレスしすぎれば前線の体力を使うが守備的、
 *    抑えれば体力は残るが失点の可能性が上がる、のように、どのつまみも何かを得て何かを失う。
 * 🔑 作る順（オーナー指定）: 標準の型（STANDARD）を現実の数字に合うまで探す → そこからつまみをずらして
 *    ハイプレス・ダイレクト・低ブロック・ポゼッションの4つに派生させ、4すくみにする。
 * 🔑 値はすべて設計値（出典なし）。合っているかは試合の数字を `docs/realism-reference.md` と比べて確かめる。
 */

export interface Tactics {
  // ---- 守備
  /** 相手のボールが自陣ゴールからこの距離（m）より近ければ寄せる。遠ければ構える（CONTAIN） */
  pressStartM: number;
  /** 寄せ役は、ボールまでこの距離（m）に入ってから全力で寄せる（それまではランニング） */
  closeDownM: number;
  /** ボールを失った直後の奪い返し: この人数が（プレス開始位置に関係なく）この秒数だけ寄せる。0人ならしない */
  counterPressPlayers: number;
  counterPressS: number;
  /** 守るときのブロックの位置（自陣ゴールから「ボールまでの距離 × 0.6 ＋ この値」m） */
  defendOffsetM: number;
  /** 守るときの陣形（ボールが遠いとき）と、ゴール前で詰めた陣形（m） */
  defendShape: { length: number; width: number };
  compactShape: { length: number; width: number };
  /** ゴール前でシュートコースを塞ぐ人数と、塞ぎ始める距離（自陣ゴールから m） */
  shieldCount: number;
  shieldZoneM: number;
  /** ゴール前で相手に1人ずつ付く（マンツーマン）最大の人数。0 なら場所を守るだけ（ゾーン） */
  markCount: number;
  // ---- 攻撃
  /** 攻めるときのブロックの位置と陣形 */
  attackOffsetM: number;
  attackShape: { length: number; width: number };
  /** パスが安全かを読むとき、相手はこれだけで反応するとみなす（秒）。長いほど大胆（リスクを取る） */
  passOppReactS: number;
  /** 寄せられていないとき、受けてからこの秒数は出さずに持つ（運ぶ）。0 なら出せるときはすぐ出す */
  holdBeforePassS: number;
  /** 前へ急ぐ度合い: パスの価値に「前へ進んだ距離 ÷ ピッチの長さ × これ」を足す。0 なら受ける地点の価値だけで選ぶ。
   *  大きいほど、安全な横・後ろのパスより、通る見込みのある前へのパス（ロングボール・スルーパス）を選ぶ */
  progressBonus: number;
  /** 出し先の候補・裏へ走り込む人数・クロスの場面でゴール前へ入る人数 */
  outletCount: number;
  runnerCount: number;
  boxCount: number;
  /** シュート・クロスを打つ見込みの閾値（0〜1）。シュートは、ほかの手（パス・運ぶ）の価値より見込みが高いことも要る */
  shootMinChance: number;
  crossMinChance: number;
}

/**
 * 標準の型（2026-10-05 決定・D-42 の「標準の型を決める」）。
 * 🔑 撃つ見込みの閾値（shootMinChance）0.04 は、シュートのブレ 8°（execution.ts）と組で、12試合の平均が
 *    シュート 0.237・得点 0.028（実プレー1分あたり・現実 約0.23・0.027）、エリア内から撃つ割合 66%（現実 56〜68%）。
 *    閾値 0.03〜0.12 × ブレ 4〜8° を回して選んだ。
 * 🔑 ここからつまみをずらして、ハイプレス・ダイレクト・低ブロック・ポゼッションの4つを作る（次の段階）。
 */
export const STANDARD: Tactics = {
  pressStartM: 60.0,
  closeDownM: 10.0,
  counterPressPlayers: 0,
  counterPressS: 0.0,
  defendOffsetM: 10.0,
  defendShape: { length: 32.5, width: 37.3 },
  compactShape: { length: 24.0, width: 32.0 },
  shieldCount: 2,
  shieldZoneM: 25.0,
  markCount: 4,
  attackOffsetM: 22.0,
  attackShape: { length: 36.0, width: 41.0 },
  passOppReactS: 0.05,
  holdBeforePassS: 0.0,
  progressBonus: 0.0,
  outletCount: 3,
  runnerCount: 2,
  boxCount: 3,
  shootMinChance: 0.04,
  crossMinChance: 0.2,
};
