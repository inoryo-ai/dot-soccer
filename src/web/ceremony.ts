/**
 * 試合の節目の演出 — キックオフ・ハーフタイム・試合終了（2026-10-03 オーナー指示）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここもゲームの規則を1行も持たない
 * ─────────────────────────────────────────────────────────────
 * どちらのチームが蹴るかは `src/sim/engine.ts` の `kickoffTeamOfHalf()` が決める。
 * ここはそれを**読んで出すだけ**。画面側で「前半はホーム」と書き足すと、
 * 片方を直したときにもう片方が嘘になる。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 競技規則に沿わせたところ（オーナー指示「実際のサッカーの開始方法に則って」）
 * ─────────────────────────────────────────────────────────────
 * - 前半と後半は**違うチーム**が蹴り、後半は**エンドが入れ替わる**
 * - 蹴る側以外の選手は**センターサークルの外**で待つ（盤の絵はエンジンが出した本物）
 * - 主審の笛で始まる。前半終了・試合終了も笛
 *
 * 🔑 どの演出も**押せば飛ばせる**。毎試合かならず待たされるのは苦痛なので、
 *    画面のどこを押しても次へ進む。
 */

import { kickoffTeamOfHalf } from "../sim/engine.ts";

export interface Sides {
  home: string;
  away: string;
  /** 自分のチームが 0=ホーム / 1=アウェー。★を付ける先 */
  myIndex: number;
}

export interface Scorer {
  time: string;
  team: string;
  player: string;
}

/* いま出ている演出を外から畳むための後始末。「結果まで飛ばす」で使う */
let closeCurrent: (() => void) | null = null;

function $(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`演出の置き場 #${id} が無い`);
  return n;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** 動きを減らす設定の人には、待ち時間そのものを短くする */
function reduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const wait = (ms: number): Promise<void> =>
  new Promise((done) => { window.setTimeout(done, reduced() ? Math.min(ms, 120) : ms); });

/**
 * 幕を出す。`build` が中身を作り、`run` が進行を書く。
 *
 * 🔴 `run` が途中で終わっても**必ず幕を畳む**。畳み忘れると、
 *    画面の上に透明な板が残って**どこを押しても反応しない**状態になる。
 */
function curtain(cls: string, build: (box: HTMLElement) => void,
                 run: (box: HTMLElement, skipped: () => boolean) => Promise<void>): Promise<void> {
  const layer = $("ceremony");
  layer.textContent = "";
  layer.className = `ceremony ${cls}`;
  layer.hidden = false;

  const box = el("div", "cm-box");
  build(box);
  layer.append(box);

  let skip = false;
  const onTap = (): void => { skip = true; };
  layer.addEventListener("pointerdown", onTap);

  return new Promise<void>((done) => {
    const close = (): void => {
      layer.removeEventListener("pointerdown", onTap);
      layer.hidden = true;
      layer.textContent = "";
      closeCurrent = null;
      done();
    };
    closeCurrent = close;
    void run(box, () => skip).then(close, (e: unknown) => {
      console.error("[dot-soccer] 演出で失敗", e);
      close();        /* 🔴 失敗しても幕は畳む。残すと操作不能になる */
    });
  });
}

/**
 * 主審の笛。
 *
 * 🔑 音は鳴らさない（音を出すには利用者の操作の許可が要る）。
 * 🔴 絵文字を使わない。笛の絵文字は無く、近いものを置くと**鐘**に見えた（2026-10-03 の目視）。
 *    印は CSS で描いて、文字で長さを出す。
 */
function whistle(box: HTMLElement, text: string): void {
  const w = el("div", "cm-whistle");
  const mark = el("span", "cm-whistle-mark");
  mark.setAttribute("aria-hidden", "true");
  w.append(mark, el("span", "cm-whistle-text", text));
  box.append(w);
}

/* ------------------------------------------------------------ キックオフ */

/**
 * 前半・後半の開始。
 *
 * @param half 1=前半 / 2=後半
 */
export function kickoff(half: 1 | 2, sides: Sides): Promise<void> {
  const taker = kickoffTeamOfHalf(half);
  const takerName = taker === 0 ? sides.home : sides.away;
  const takerSide = taker === 0 ? "ホーム" : "アウェー";

  return curtain("cm-kickoff", (box) => {
    box.append(el("div", "cm-half", half === 1 ? "前半" : "後半"));

    const vs = el("div", "cm-vs");
    vs.append(
      el("span", `cm-side cm-home${sides.myIndex === 0 ? " is-mine" : ""}`,
         (sides.myIndex === 0 ? "★ " : "") + sides.home),
      el("span", "cm-vs-mark", "VS"),
      el("span", `cm-side cm-away${sides.myIndex === 1 ? " is-mine" : ""}`,
         sides.away + (sides.myIndex === 1 ? " ★" : "")),
    );
    box.append(vs);

    /* 🔑 後半は**エンドが入れ替わる**。入れ替わったことを言わないと、
          盤の左右が逆になった理由が分からない */
    if (half === 2) box.append(el("div", "cm-note", "エンド交代 — 攻める向きが入れ替わります"));

    box.append(el("div", "cm-ball", `${takerSide} ${takerName} のキックオフ`));
  }, async (box, skipped) => {
    await wait(900);
    if (skipped()) return;
    whistle(box, "ピッ");
    box.classList.add("is-go");
    await wait(700);
  });
}

/* ------------------------------------------------------------ ハーフタイム */

/**
 * 前半終了。**押すまで待つ**（ここだけは自動で進めない）。
 *
 * 🔑 出すのは得点と得点者だけ。支配率やシュート数は**前半だけの値を持っていない**ので、
 *    それらしい数字を作らない。無い数字を出すほうが、出さないより悪い。
 */
export function halfTime(sides: Sides, home: number, away: number,
                         scorers: Scorer[]): Promise<void> {
  return curtain("cm-half-time", (box) => {
    box.append(el("div", "cm-half", "ハーフタイム"));

    const sc = el("div", "cm-score");
    sc.append(
      el("span", `cm-side cm-home${sides.myIndex === 0 ? " is-mine" : ""}`, sides.home),
      el("span", "cm-score-num", `${home} - ${away}`),
      el("span", `cm-side cm-away${sides.myIndex === 1 ? " is-mine" : ""}`, sides.away),
    );
    box.append(sc);

    const list = el("div", "cm-scorers");
    if (scorers.length === 0) {
      list.append(el("div", "cm-note", "前半は得点なし"));
    } else {
      for (const g of scorers) {
        const row = el("div", "cm-scorer");
        row.append(el("span", "cm-scorer-time", g.time),
                   el("span", "cm-scorer-name", `${g.player}（${g.team}）`));
        list.append(row);
      }
    }
    box.append(list);
  }, async (box, skipped) => {
    whistle(box, "ピーッ");
    const go = el("button", "btn btn-primary btn-big", "後半へ");
    (go as HTMLButtonElement).type = "button";
    box.append(go);
    go.focus();
    await new Promise<void>((done) => {
      go.addEventListener("click", () => done());
      /* 画面のどこを押しても進める。待たせっぱなしにしない */
      const poll = window.setInterval(() => {
        if (skipped()) { window.clearInterval(poll); done(); }
      }, 100);
    });
  });
}

/* ------------------------------------------------------------ 試合終了 */

export function fullTime(sides: Sides, home: number, away: number): Promise<void> {
  const mine = sides.myIndex === 0 ? home : away;
  const theirs = sides.myIndex === 0 ? away : home;
  const word = mine > theirs ? "勝ち" : mine < theirs ? "負け" : "引き分け";
  const tone = mine > theirs ? "is-win" : mine < theirs ? "is-lose" : "is-draw";

  return curtain(`cm-full-time ${tone}`, (box) => {
    box.append(el("div", "cm-half", "試合終了"));
    const sc = el("div", "cm-score");
    sc.append(
      el("span", `cm-side cm-home${sides.myIndex === 0 ? " is-mine" : ""}`, sides.home),
      el("span", "cm-score-num", `${home} - ${away}`),
      el("span", `cm-side cm-away${sides.myIndex === 1 ? " is-mine" : ""}`, sides.away),
    );
    box.append(sc);
    box.append(el("div", "cm-result", word));
  }, async (box, skipped) => {
    /* 🔑 試合終了は**長い笛**。前半終了の短い笛と区別が付く */
    whistle(box, "ピーーーッ");
    await wait(1400);
    if (skipped()) return;
    await wait(800);
  });
}

/** 出ている演出を今すぐ畳む（「結果まで飛ばす」用） */
export function cancel(): void {
  closeCurrent?.();
}
