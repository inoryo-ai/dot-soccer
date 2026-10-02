/**
 * 画面の演出（飛ぶ数字・知らせの帯・散る粒）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここにゲームの規則を1行も書かない
 * ─────────────────────────────────────────────────────────────
 * このファイルは「渡された文字を、渡された場所から飛ばす」だけ。
 * **何が何点伸びたかを決めるのは `src/sim/`**。ここは結果を受け取って動かすだけ。
 * 判定を混ぜると、画面を変えただけで試合の結果が変わる状態になる。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 なぜ演出が要るのか（飾りではない）
 * ─────────────────────────────────────────────────────────────
 * 特訓は「表のどこかの数字が 41 から 43 に変わる」だけの出来事で、
 * **画面を見ていても起きたことに気づけない**。実際に遊ぶと
 * 「特訓したのに何も起きていないのでは」と手が止まる。
 * そこで、伸びた数字を**その場から飛び上がらせる**。
 * どこが変わったかと、変わったこと自体を、同時に伝えるのが目的。
 *
 * 🔑 動きを減らす設定の人には**何も作らない**。
 *    CSS 側だけで消すと、要素は増え続けるのに見えないという無駄が残る。
 */

/** 残してよい演出の数。これを超えたら古いものから消す（押し続けても増え続けないように） */
const MAX_NODES = 24;

const reduced = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function layer(): HTMLElement | null {
  return document.getElementById("fxLayer");
}

/** 置いたら、動き終わりに自分で片付ける。片付けないと DOM が伸び続ける */
function put(box: HTMLElement, node: HTMLElement, fallbackMs: number): void {
  while (box.childElementCount >= MAX_NODES) box.firstElementChild?.remove();
  box.append(node);
  node.addEventListener("animationend", () => node.remove(), { once: true });
  // 🔑 animation が走らなかった場合（タブが裏など）の保険。消し忘れを残さない
  globalThis.setTimeout(() => node.remove(), fallbackMs);
}

/** 要素の中心（画面座標）。飛ばす起点に使う */
function center(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * 「+2」のような短い文字を、`from` の位置から飛び上がらせて消す。
 *
 * @param text  出す文字。**中身は呼び出し側が決める**（ここでは計算しない）
 * @param from  飛ばす起点の要素
 * @param i     同時に複数飛ばすときの順番。少しずつ遅らせて重ならないようにする
 */
export function floatNum(text: string, from: Element, i = 0): void {
  const box = layer();
  if (!box || reduced()) return;
  const { x, y } = center(from);
  const node = document.createElement("div");
  node.className = "float-num";
  node.textContent = text;
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  // 🔑 1つずつずらす。同時に出すと数字が重なって読めない
  node.style.animationDelay = `${i * 90}ms`;
  put(box, node, 1400 + i * 90);
}

/** 大きな知らせ（タイプが変わった等）を帯で出す。短い1文だけ。 */
export function ribbon(text: string): void {
  const box = layer();
  if (!box || reduced()) return;
  const node = document.createElement("div");
  node.className = "ribbon";
  node.textContent = text;
  put(box, node, 2200);
}

/**
 * 粒を四方へ散らす。ゴールと、タイプが変わった瞬間に撒く。
 *
 * 🔑 向きは等間隔に配る（乱数を引かない）。
 *    画面の演出で乱数を引くと、同じシードでも見た目が変わり、
 *    「同じ結果になる」の確認（D-16）が目で追えなくなる。
 */
export function sparks(from: Element, count = 8): void {
  const box = layer();
  if (!box || reduced()) return;
  const { x, y } = center(from);
  const reach = 46;
  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i) / count;
    const node = document.createElement("div");
    node.className = "spark";
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.setProperty("--dx", `${Math.round(Math.cos(a) * reach)}px`);
    node.style.setProperty("--dy", `${Math.round(Math.sin(a) * reach)}px`);
    node.style.animationDelay = `${i * 12}ms`;
    put(box, node, 700 + i * 12);
  }
}
