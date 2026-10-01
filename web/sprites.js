/* 選手のドット絵を**コードで描いて作る**。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 画像ファイルを持ち込まない
 * ─────────────────────────────────────────────────────────────
 * 要件定義書 §12「名称・キャラ・ドット絵・UIをオリジナルにする」。
 * 手続きで描けば、出どころの問題が起きようがない。
 * チームの色も走り方もここで決めているので、差し替えも1か所で済む。
 *
 * 🔑 毎コマ描き直さない。**向き×コマ×チーム色の組み合わせを一度だけ描いて貯める**。
 *    22人 × 毎秒60回を都度描くと、スマホで間に合わない。
 *
 * 🔑 1ドットを1点として描き、表示のときだけ拡大する（`imageSmoothingEnabled = false`）。
 *    先に拡大してから描くと、ドットの角が丸まって「ドット絵」でなくなる。
 */

'use strict';

const Sprites = (() => {
  const W = 12;              // 1枚の幅（ドット）
  const H = 18;              // 1枚の高さ（ドット）
  const FEET_Y = 17;         // 足元の位置。ここをピッチ上の座標に合わせる

  /* 向きは8方向。走っている向きでどれを使うか決める */
  const DIRS = 8;
  /* 走りは4コマ（接地→送り→接地→送り）、止まっているときは2コマ */
  const RUN_FRAMES = 4;

  const cache = new Map();   // key -> canvas

  /** 1ドット打つ。canvas の外は無視する */
  function dot(ctx, x, y, color) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  }

  function rect(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  /**
   * 1枚描く。
   *
   * @param dir   0..7（0=奥へ, 2=右, 4=手前へ, 6=左）
   * @param frame 0..3（走りのコマ）
   * @param moving 走っているか
   */
  function draw(ctx, colors, dir, frame, moving) {
    const { shirt, shirtDark, shorts, skin, hair, socks } = colors;

    /* 横向きの度合い。真横ほど体を細く、奥/手前ほど広く見せる */
    const side = Math.abs(Math.sin((dir / DIRS) * Math.PI * 2));      // 0..1
    const bodyW = Math.round(4 + (1 - side) * 2);                      // 4〜6
    const cx = Math.floor(W / 2);
    const left = cx - Math.floor(bodyW / 2);

    /* 足の振り。止まっているときは軽く上下するだけ */
    const swing = moving
      ? [0, 1, 0, -1][frame]
      : [0, 0, 0, 0][frame];
    const bob = moving ? [0, -1, 0, -1][frame] : [0, 0, -1, 0][frame];

    const top = 2 + bob;

    /* 影は本体側に描かない（接地位置が変わるとズレるため、盤面側で描く） */

    /* 脚 */
    const legY = top + 11;
    rect(ctx, left + 1, legY, 1, 4 - Math.abs(swing), socks);
    rect(ctx, left + bodyW - 2, legY, 1, 4 - Math.abs(swing), socks);
    /* 走っているときは前後に開く */
    if (moving && swing !== 0) {
      dot(ctx, left + 1 - (swing > 0 ? 1 : 0), legY + 3, socks);
      dot(ctx, left + bodyW - 2 + (swing > 0 ? 0 : 1), legY + 3, socks);
    }

    /* 短パン */
    rect(ctx, left, top + 9, bodyW, 3, shorts);

    /* 胴（縁取り→本体の2段で、平たく見えないようにする） */
    rect(ctx, left - 1, top + 4, bodyW + 2, 6, shirtDark);
    rect(ctx, left, top + 4, bodyW, 5, shirt);
    /* 光の当たる側（左上）を1段明るく＝立体に見せる */
    rect(ctx, left, top + 4, 1, 4, shirt);

    /* 腕。走っているときは脚と逆に振る */
    const armY = top + 5;
    rect(ctx, left - 1, armY + (moving ? -swing : 0), 1, 4, skin);
    rect(ctx, left + bodyW, armY + (moving ? swing : 0), 1, 4, skin);

    /* 頭 */
    rect(ctx, cx - 2, top, 4, 4, skin);
    /* 髪。奥を向いているときは後頭部なので広く塗る */
    const back = dir === 0 || dir === 1 || dir === 7;
    rect(ctx, cx - 2, top, 4, back ? 3 : 2, hair);
    /* 手前を向いているときだけ目を打つ（1ドットで十分「顔」に見える） */
    if (dir === 3 || dir === 4 || dir === 5) {
      dot(ctx, cx - 1, top + 2, '#2a1a10');
      dot(ctx, cx + 1, top + 2, '#2a1a10');
    }
  }

  function key(teamKey, dir, frame, moving) {
    return `${teamKey}:${dir}:${frame}:${moving ? 1 : 0}`;
  }

  /** その組み合わせの1枚を返す（無ければ描いて貯める） */
  function get(teamKey, colors, dir, frame, moving) {
    const k = key(teamKey, dir, frame, moving);
    const hit = cache.get(k);
    if (hit) return hit;

    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    draw(ctx, colors, dir, frame, moving);
    cache.set(k, c);
    return c;
  }

  /** 進む向き（ラジアン）を8方向の番号にする */
  function dirOf(angle) {
    /* 画面では y が下向きなので、そのまま8分割してよい */
    const t = (angle + Math.PI * 2) % (Math.PI * 2);
    return Math.round((t / (Math.PI * 2)) * DIRS) % DIRS;
  }

  return { get, dirOf, W, H, FEET_Y, RUN_FRAMES };
})();
