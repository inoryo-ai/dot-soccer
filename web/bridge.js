/* Pyodide を立ち上げて `sim/` をブラウザの中で動かす。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ JavaScript で書き直さないのか
 * ─────────────────────────────────────────────────────────────
 * 試合の規則は `sim/`（Python）にしかない。JS に写すと**エンジンが2つになり**、
 * テスト82件と検査9項目は Python 側にしか無いので、どちらが正かが崩れる。
 * 見た目を付けるために正本を割るのは割に合わない。
 *
 * 🔴 Python 側の例外を握りつぶさない。握りつぶすと「押しても何も起きない画面」になる。
 *    `GameError`（画面に出してよい日本語）と、それ以外（こちらの不具合）を分けて返す。
 */

'use strict';

const Bridge = (() => {
  let pyodide = null;
  let api = null;                 // Python の `api` モジュール（プロキシ）
  let ready = false;

  /** Python の値を素の JS の値にする。
   *
   * 🔑 `toJs` のままだと Map が返り、`obj.key` で読めない。
   *    ここで**一度だけ**素のオブジェクトへ直す。画面側では変換を書かない。
   */
  function toPlain(pyValue) {
    if (pyValue === null || pyValue === undefined) return null;
    if (typeof pyValue.toJs !== 'function') return pyValue;
    const js = pyValue.toJs({ dict_converter: Object.fromEntries });
    pyValue.destroy();
    return js;
  }

  class GameError extends Error {}

  async function boot(onProgress) {
    const say = (pct, msg) => { if (onProgress) onProgress(pct, msg); };

    say(8, 'Python の実行環境を読み込んでいます…');
    pyodide = await loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/',
    });

    say(55, 'ゲームの中身を読み込んでいます…');
    /* 🔴 一覧だけは**絶対にキャッシュから読まない**。
       ここが古いと、そこに書いてある刻印も古くなり、刻印の意味が消える。 */
    const manifest = await (await fetch('py/manifest.json', { cache: 'no-store' })).json();
    const stamp = manifest.stamp || '';

    pyodide.FS.mkdirTree('/game/sim');
    const files = [
      ...manifest.sim.map((n) => [`py/sim/${n}`, `/game/sim/${n}`]),
      ...manifest.top.map((n) => [`py/${n}`, `/game/${n}`]),
    ];
    /* 🔴 刻印を付けて取りに行く。付けないと、ブラウザが一部のファイルだけ
       古い写しを返し、**新しいものと混ざった状態**で動いてしまう。
       2026-09-30 に実際に起きた（model.py だけ古く、api.py だけ新しかった）。 */
    const sources = await Promise.all(files.map(async ([url, dest]) => {
      const res = await fetch(`${url}?v=${stamp}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${url} を読めません（${res.status}）`);
      return [dest, await res.text()];
    }));
    for (const [dest, text] of sources) {
      pyodide.FS.writeFile(dest, text, { encoding: 'utf8' });
    }

    say(80, 'ルールを組み立てています…');
    await pyodide.runPythonAsync(`
import sys
if "/game" not in sys.path:
    sys.path.insert(0, "/game")
import api
`);
    api = pyodide.pyimport('api');

    say(100, '準備ができました');
    ready = true;
  }

  /** Python の関数を呼んで、素の JS の値で返す。 */
  function call(name, ...args) {
    if (!ready) throw new Error('まだ準備ができていません');
    try {
      const fn = api[name];
      if (typeof fn !== 'function') throw new Error(`api.${name} がありません`);
      const converted = args.map((a) => (
        a !== null && typeof a === 'object' ? pyodide.toPy(a) : a));
      const result = fn(...converted);
      converted.forEach((c) => { if (c && c.destroy) c.destroy(); });
      return toPlain(result);
    } catch (e) {
      /* 🔑 Python 側の `GameError` は画面にそのまま出してよい日本語。
         それ以外はこちらの不具合なので、原因が分かる形で投げ直す。 */
      const text = String(e && e.message ? e.message : e);
      const marker = 'api.GameError: ';
      const at = text.indexOf(marker);
      if (at >= 0) {
        const line = text.slice(at + marker.length).split('\n')[0].trim();
        throw new GameError(line);
      }
      throw e;
    }
  }

  return { boot, call, GameError, isReady: () => ready };
})();
