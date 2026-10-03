/**
 * 背景の確認台（`web/bgcheck.html`）。**検証用でゲーム本体には出ない。**
 *
 * 🔑 見たいのは2つだけ。
 *    ① 中央58%（手前にパネルが載る帯）に見せ場が入っていないか
 *    ② 街の「押せる場所」が建物の上に乗っているか
 *       （絵と当たり判定がずれるのが、この手の差し替えで一番よく起きる壊れ方）
 */

import * as Bg from "./bg.ts";

const ITEMS: { kind: Bg.Kind; label: string; spots: boolean }[] = [
  { kind: "town", label: "街ハブ（昼）", spots: true },
  { kind: "town-night", label: "街ハブ（夜）", spots: true },
  { kind: "arcade", label: "商店街", spots: false },
  { kind: "office", label: "事務所", spots: false },
];

const SPOT_LABEL: Record<string, string> = {
  stadium: "サッカー場", shop: "商店街", office: "事務所",
};

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function main(): void {
  const list = document.getElementById("list");
  if (list === null) throw new Error("確認台に #list が無い");

  for (const item of ITEMS) {
    const box = el("div", "bgc-item");
    const head = el("div", "bgc-head");
    head.append(el("strong", undefined, item.label));
    box.append(head);

    const stage = el("div", "bgc-stage");
    const cv = document.createElement("canvas");
    stage.append(cv);
    stage.append(el("div", "bgc-guide"));
    if (item.spots) {
      for (const [key, at] of Object.entries(Bg.TOWN_SPOTS)) {
        const s = el("span", "bgc-spot", SPOT_LABEL[key] ?? key);
        s.style.left = `${at.left}%`;
        s.style.top = `${at.top}%`;
        stage.append(s);
      }
    }
    box.append(stage);
    list.append(box);

    /* 🔑 大きさが決まってから描く（`getBoundingClientRect` が 0 だと1倍になる） */
    requestAnimationFrame(() => { Bg.draw(cv, item.kind); });
  }
}

main();
