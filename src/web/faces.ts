/**
 * 顔パーツの確認台（`web/faces.html`）。**検証用でゲーム本体には出ない。**
 *
 * 🔑 髪20 × 顔10 × 色5 = 1000通りを**一度に並べて見る**ための台。
 *    試合画面や盤の上では1つずつしか出ないので、
 *    「似すぎている髪型」「小さくすると潰れる顔」がここでしか見つからない。
 *
 * 🔴 ここもゲームの規則を1行も持たない。
 */

import * as Face from "./face.ts";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`確認台に #${id} が無い`);
  return n as T;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

let px = 4;
let color = 0;

/** 髪20 × 顔10 の表。行＝髪型、列＝顔つき */
function renderGrid(): void {
  const box = $("grid");
  box.textContent = "";

  const head = el("div", "fc-row");
  head.append(el("div", "fc-label", ""));
  for (const s of Face.FACE_SHAPES) head.append(el("div", "fc-head", s.label));
  box.append(head);

  Face.HAIR_STYLES.forEach((hair, hi) => {
    const row = el("div", "fc-row");
    row.append(el("div", "fc-label", hair.label));
    Face.FACE_SHAPES.forEach((_, si) => {
      const cell = el("div", "fc-cell");
      cell.append(Face.toCanvas({ hair: hi, shape: si, color }, px));
      row.append(cell);
    });
    box.append(row);
  });
}

/** 色5種を並べる */
function renderColors(): void {
  const box = $("colors");
  box.textContent = "";
  Face.HAIR_COLORS.forEach((col, i) => {
    const b = el("button", `chip${i === color ? " is-on" : ""}`);
    (b as HTMLButtonElement).type = "button";
    b.append(Face.toCanvas({ hair: 0, shape: 0, color: i }, 3),
             el("span", undefined, col.label));
    b.addEventListener("click", () => { color = i; renderColors(); renderGrid(); });
    box.append(b);
  });
}

/**
 * 名前から顔が決まることを目で確かめる台。
 *
 * 🔑 同じ名前を2回入れて同じ顔になることより、
 *    **違う名前が散らばること**のほうが大事。偏ると「同じ顔ばかりのチーム」になる。
 */
function renderNames(): void {
  const box = $("names");
  box.textContent = "";
  const raw = $<HTMLTextAreaElement>("nameInput").value;
  for (const name of raw.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const spec = Face.faceOf(name);
    const cell = el("div", "fc-name");
    cell.append(Face.toCanvas(spec, 4));
    cell.append(el("span", "fc-name-text", name));
    cell.append(el("span", "fc-name-sub",
                   `${Face.HAIR_STYLES[spec.hair]!.label} / ${Face.FACE_SHAPES[spec.shape]!.label}`
                 + ` / ${Face.HAIR_COLORS[spec.color]!.label}`));
    box.append(cell);
  }
}

function main(): void {
  $("count").textContent =
    `${Face.HAIR_STYLES.length} × ${Face.FACE_SHAPES.length} × ${Face.HAIR_COLORS.length}`
    + ` = ${Face.HAIR_STYLES.length * Face.FACE_SHAPES.length * Face.HAIR_COLORS.length} 通り`;

  const zoom = $<HTMLInputElement>("zoom");
  const apply = (): void => {
    px = Number(zoom.value);
    $("zoomVal").textContent = `${px}倍`;
    renderGrid();
  };
  zoom.addEventListener("input", apply);

  $("nameInput").addEventListener("input", renderNames);

  renderColors();
  apply();
  renderNames();
}

main();
