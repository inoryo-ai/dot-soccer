/**
 * 効用で選ぶ（決定 D-35 の「個人の判断」の層・D-41）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜくじ引きをやめたのか
 * ─────────────────────────────────────────────────────────────
 * 以前の個人の判断は「重みつきのくじ」だった（`pick`）。これだと、
 * ガンビット（ユーザーが書くルール）で倍率をかけても「当たりやすくなる」止まりで、
 * **指示にならない**。書いたのに3回に1回しか従わない選手は、事故にしか見えない。
 *
 * そこで、候補を**同じ物差しで採点して最大を選ぶ**形にする。
 * 倍率が勝ち負けを入れ替えれば必ず従うので、ルールが「指示」になる。
 *
 * 🔑 採点は**項目ごとに理由つきで**残す（Iron Loyalty の Commander の形を借りた）。
 *    試合後の「ルール2が14回発動・枠内5」という集計（D-35）は、
 *    どの項目が勝敗を決めたかを数えるだけで出せるようになる。
 *
 * 🔴 最後にくじを引かない。同点は**先に並んだ候補**を取る（並び順は呼ぶ側が決める）。
 *    くじに戻すと、上の理由がそのまま崩れる。
 */

/** 採点の1項目。`op` が "×" なら倍率、"+" なら加点。 */
export interface Term {
  readonly label: string;
  readonly op: "×" | "+";
  readonly value: number;
}

/** 採点を組み立てる。値と、そこに至った理由の列を一緒に持つ。 */
export class Score {
  value: number;
  readonly terms: Term[];

  constructor(label: string, base: number) {
    this.value = base;
    this.terms = [{ label, op: "+", value: base }];
  }

  /** 倍率をかける。 */
  times(label: string, f: number): this {
    this.value *= f;
    this.terms.push({ label, op: "×", value: f });
    return this;
  }

  /** 加点（負なら減点）する。 */
  plus(label: string, v: number): this {
    this.value += v;
    this.terms.push({ label, op: "+", value: v });
    return this;
  }
}

/** 候補1つ。`action` が何をするか、`score` がその採点。 */
export interface Choice<A> {
  readonly action: A;
  readonly score: Score;
}

/**
 * 最も採点の高い候補を返す。**同点なら先に並んだもの**。
 *
 * 🔴 `>` で比べる（`>=` にすると同点で後ろが勝ち、並び順の約束が逆になる）。
 */
export function chooseBest<A>(choices: readonly Choice<A>[]): Choice<A> {
  let best: Choice<A> | undefined;
  for (const c of choices) {
    if (best === undefined || c.score.value > best.score.value) best = c;
  }
  if (best === undefined) throw new RangeError("候補が無いと選べない");
  return best;
}

/** 理由の列を人が読める1行にする（ログ・検査の失敗メッセージ用）。 */
export function explain(score: Score): string {
  return score.terms.map((t, i) => (i === 0 ? `${t.label} ${t.value.toFixed(3)}`
                                            : `${t.op} ${t.label} ${t.value.toFixed(3)}`))
    .join(" ") + ` = ${score.value.toFixed(3)}`;
}
