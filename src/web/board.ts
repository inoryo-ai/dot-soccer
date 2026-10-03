/**
 * 配置盤 — サッカー場の絵の上で選手をつまんで動かす（2026-10-03 オーナー指示）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここもゲームの規則を持たない
 * ─────────────────────────────────────────────────────────────
 * 誰がどの枠に立つかも、動かしてよい範囲も、決めるのは `src/sim/` 。
 * この層は「つまんだ指の位置を 0〜1 の割合に直して渡す」だけ。
 * 正しいかどうかの判定は `api.setLineup()` が投げる例外で受ける。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 なぜ Pointer Events か
 * ─────────────────────────────────────────────────────────────
 * `dragstart`（HTML5 のドラッグ＆ドロップ）は**スマホで動かない**。
 * `mousedown` だけだと指で動かせない。Pointer Events なら
 * マウス・指・ペンが同じ1本の道で来る。
 * `setPointerCapture` を使うと、速く振って駒の外へ出ても追い続けられる。
 */

import type { LineupSpot } from "./api.ts";

/** 駒を置ける範囲（割合）。端まで行くと駒が盤から見切れる */
const PAD = 0.03;

const POS_CLASS: Record<string, string> = {
  GK: "bd-gk", DF: "bd-df", MF: "bd-mf", FW: "bd-fw",
};

export interface BoardHooks {
  /** 動かし終わったときに呼ばれる。11個ぶんの `[x, y]` を渡す */
  commit: (spots: [number, number][]) => void;
  /** 画面に出す短い知らせ（「GKは自陣まで」など） */
  say: (text: string) => void;
}

let spots: [number, number][] = [];
let seats: LineupSpot[] = [];
let hooks: BoardHooks | null = null;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * 盤を描き直す。
 *
 * @param root 盤を入れる箱
 * @param list `api.view().lineup`。**これが正**で、盤はその写し
 */
export function render(root: HTMLElement, list: LineupSpot[], h: BoardHooks): void {
  hooks = h;
  seats = list;
  spots = list.map((s) => [s.x, s.y]);
  root.textContent = "";
  root.classList.add("board");

  /* 芝と線。ピッチは横長なので、盤も横長にする（縦にすると向きを間違える） */
  const grass = el("div", "board-grass");
  grass.append(el("div", "board-mid"), el("div", "board-circle"),
               el("div", "board-pa board-pa-l"), el("div", "board-pa board-pa-r"),
               el("div", "board-goal board-goal-l"), el("div", "board-goal board-goal-r"));
  root.append(grass);

  /* 攻める向きの札。これが無いと左右どちらへ攻めるのか分からない */
  const arrow = el("div", "board-dir", "← 自ゴール　　攻める向き →");
  root.append(arrow);

  list.forEach((s, i) => root.append(chip(root, s, i)));
}

function chip(root: HTMLElement, s: LineupSpot, i: number): HTMLElement {
  const c = el("button", `board-chip ${POS_CLASS[s.pos] ?? ""}`);
  (c as HTMLButtonElement).type = "button";
  c.dataset.index = String(i);
  c.append(el("span", "board-pos", s.pos), el("span", "board-name", s.name));
  place(c, spots[i]![0], spots[i]![1]);

  /* 🔑 つまんでいる指に名前を付けて追う。途中で別の指が触っても混ざらない */
  let dragging = false;
  let moved = false;

  c.addEventListener("pointerdown", (e) => {
    /* 🔴 捕まえられなくても**つまめる状態にはする**。
          `setPointerCapture` は環境によっては失敗して例外を投げる。
          これを捕まえずに置くと、以降の行が実行されず
          「押しても何も起きない駒」になる（原因が画面からは見えない）。
          捕まえられない場合は、駒の外へ速く振ったときに追従が切れるだけで済む。 */
    try {
      c.setPointerCapture(e.pointerId);
    } catch {
      /* 追従が弱くなるだけ。動かせなくなるよりはよい */
    }
    dragging = true;
    moved = false;
    c.classList.add("is-held");
    e.preventDefault();
  });

  c.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    moved = true;
    const r = root.getBoundingClientRect();
    let fx = clamp((e.clientX - r.left) / r.width);
    const fy = clamp(1 - (e.clientY - r.top) / r.height);   // 画面は下向き、ピッチは上向き
    /* 🔑 GK は指についてこない。**動かしてから弾く**のではなく、
          そもそも越えられないほうが「出せない」ことが手で分かる。
          上限の値は規則の層（`locked_x`）から来る。ここで決めない。 */
    const max = seats[i]?.locked_x ?? null;
    if (max !== null && fx > max) fx = max;
    spots[i] = [fx, fy];
    place(c, fx, fy);
  });

  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    c.classList.remove("is-held");
    if (!moved) return;
    hooks?.commit(spots.map(([x, y]) => [round2(x), round2(y)]));
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);

  /* 🔑 指が使えない人のために、矢印キーでも動かせるようにする。
        ドラッグ＆ドロップしか無いと、キーボードだけでは配置を変えられない */
  c.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const mv = d[e.key];
    if (mv === undefined) return;
    e.preventDefault();
    const max = seats[i]?.locked_x ?? null;
    let nx = clamp(spots[i]![0] + mv[0]);
    if (max !== null && nx > max) nx = max;
    spots[i] = [nx, clamp(spots[i]![1] + mv[1])];
    place(c, spots[i]![0], spots[i]![1]);
    hooks?.commit(spots.map(([x, y]) => [round2(x), round2(y)]));
  });

  const seat = seats[i];
  c.title = `${s.pos} ${s.name}${seat?.locked_x !== null ? "（自陣まで）" : ""}`;
  c.setAttribute("aria-label", `${s.pos} ${s.name}。矢印キーで動かせます`);
  return c;
}

function place(c: HTMLElement, x: number, y: number): void {
  c.style.left = `${x * 100}%`;
  c.style.bottom = `${y * 100}%`;
}

const clamp = (v: number): number => Math.max(PAD, Math.min(1 - PAD, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;
