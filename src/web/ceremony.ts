/**
 * 試合の節目の演出 — キックオフ・ゴール・ハーフタイム・試合終了（2026-10-03 オーナー指示）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここもゲームの規則を1行も持たない
 * ─────────────────────────────────────────────────────────────
 * どちらのチームが蹴るかは `src/sim/engine.ts` の `kickoffTeamOfHalf()` が決める。
 * 勝ち点がいくつかは `src/sim/league.ts` の `WIN_POINTS` / `DRAW_POINTS` が決める。
 * ここはそれを**読んで出すだけ**。画面側で「前半はホーム」「勝ち点は3」と書き足すと、
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
import { WIN_POINTS, DRAW_POINTS } from "../sim/league.ts";

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
/** 幕の世代。出すたびに1つ増える。遅れて終わった古い幕が新しい幕を消さないための札 */
let gen = 0;

/**
 * 間（ま）の長さ。当てずっぽうの数字を散らさず、1か所にまとめて**理由ごと**に置く。
 *
 * 🔑 目安は「気づくまでの 0.4秒 ＋ 読む行 × 0.3秒」。日本語の短い行は
 *    1行 0.3秒くらいで目に入る。これより短いと読む前に消え、
 *    倍にすると「まだ続くのか」という待たされ方になる。
 * 🔴 ゴールだけは**合計 1.5秒以内**（オーナー指示）。得点のたびに2秒止まると、
 *    点の多い試合では演出を見ている時間のほうが長くなって見ていられない。
 */
const BEAT = {
  /** キックオフ: 見出し＋対戦＋蹴る側の3行を読む */
  kickoffRead: 980,
  /** キックオフ: 後半は「エンド交代」の1行が増えるので足す */
  kickoffSwap: 300,
  /** 笛が鳴ってから幕が引き終わるまで（笛の動き 0.5秒・幕が引く 0.28秒） */
  blow: 640,
  /** ゴール: 読む時間。見出し・状況・得点者・スコアの4行 */
  goalRead: 1180,
  /** ゴール: 幕が引くぶん。`goalRead` と合わせて 1.5秒を超えさせない */
  goalOut: 300,
  /** 試合終了: 笛 → 結果 → ひとこと の3段 */
  fullWhistle: 620,
  fullWord: 820,
  fullNote: 780,
  /** 動きを減らす設定のとき、段を一度に出してから読む時間 */
  reducedHold: 520,
} as const;

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

/**
 * 動きに関係なく待つ。
 *
 * 🔑 **読むための時間は「動き」ではない**ので、動きを減らす設定でも縮めない。
 *    段を追う演出をまとめて出すときだけ、ここを直接使う。
 */
const hold = (ms: number): Promise<void> =>
  new Promise((done) => { window.setTimeout(done, ms); });

/** 演出の進みを待つ。動きを減らす設定の人には待ち時間そのものを短くする */
const wait = (ms: number): Promise<void> => hold(reduced() ? Math.min(ms, 120) : ms);

interface CurtainOpts {
  /**
   * 幕の濃さ。省略すると CSS の既定（`.ceremony` の濃さ）。
   * 🔑 ゴールの瞬間だけは薄くする。盤の上で選手が喜んでいる絵が主役で、
   *    文字はその添えもの。
   */
  dim?: string;
}

/**
 * 幕を出す。`build` が中身を作り、`run` が進行を書く。
 *
 * 🔴 `run` が途中で終わっても**必ず幕を畳む**。畳み忘れると、
 *    画面の上に透明な板が残って**どこを押しても反応しない**状態になる。
 */
function curtain(cls: string, build: (box: HTMLElement) => void,
                 run: (box: HTMLElement, skipped: () => boolean) => Promise<void>,
                 opts: CurtainOpts = {}): Promise<void> {
  /* 🔴 **世代の札を取ってから**前の幕を畳む（2026-10-03 のレビューで直した）。
        前の演出が出ている途中で次が来たとき、畳まずに上から書き換えると、
        前の約束（Promise）が永久に解決されないまま残り、呼び出し側の
        `.then(() => Pitch.resume())` が走らず**試合が止まったまま**になる。
        かといって古い `close` をそのまま走らせると、**今出ている新しい幕を消してしまう**
        （`layer.hidden = true` と `textContent = ""` は無条件に効くため）。
        ゴールは連続して入りうるので、ここは実際に踏む。
     🔑 だから `close` は「約束は必ず返す／画面は自分が最新のときだけ触る」に分ける。 */
  const me = ++gen;
  closeCurrent?.();

  const layer = $("ceremony");
  layer.textContent = "";
  layer.className = `ceremony ${cls}`;
  /* 🔴 濃さの指定は**毎回書き戻す**。要素に直接当てた値はクラスを変えても消えないので、
        ゴールで薄くした幕がそのあとのハーフタイムにも残って文字が読みにくくなる。 */
  layer.style.background = opts.dim ?? "";
  layer.hidden = false;

  const box = el("div", "cm-box");
  try {
    build(box);
  } catch (e) {
    /* 🔴 中身を作る途中で落ちたときも幕は畳む。開いたまま投げると
          透明な板が残って操作不能になる。握りつぶさず、そのまま投げ直す。 */
    layer.hidden = true;
    layer.textContent = "";
    throw e;
  }
  layer.append(box);

  let skip = false;
  const onTap = (): void => { skip = true; };
  layer.addEventListener("pointerdown", onTap);

  return new Promise<void>((done) => {
    const close = (): void => {
      layer.removeEventListener("pointerdown", onTap);
      /* 🔴 画面を触るのは**自分が最新の幕のときだけ**。
            遅れて終わった古い `run` がここへ来たとき、無条件に消すと
            いま出ている別の幕を畳んでしまう（残りの段が描かれない・
            `cancel()` も効かなくなる）。約束（`done`）は世代に関わらず必ず返す。 */
      if (gen === me) {
        layer.hidden = true;
        layer.textContent = "";
        closeCurrent = null;
      }
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

/** スコア行（ホーム 1 - 0 アウェー）。自分のチームに印を付ける置き場は1か所にまとめる */
function scoreRow(sides: Sides, home: number, away: number): HTMLElement {
  const sc = el("div", "cm-score");
  sc.append(
    el("span", `cm-side cm-home${sides.myIndex === 0 ? " is-mine" : ""}`, sides.home),
    el("span", "cm-score-num", `${home} - ${away}`),
    el("span", `cm-side cm-away${sides.myIndex === 1 ? " is-mine" : ""}`, sides.away),
  );
  return sc;
}

/** 自分のチームから見た得点・失点に読み替える */
function mySide(sides: Sides, home: number, away: number): { mine: number; theirs: number } {
  return sides.myIndex === 0 ? { mine: home, theirs: away } : { mine: away, theirs: home };
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
    box.append(el("div", "cm-half", half === 1 ? "前半開始" : "後半開始"));

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

    /* 🔑 「ホーム ○○ のキックオフ」だと ホーム が何に付くのか読み取りにくいので、
          チーム名のうしろに括弧で添える */
    box.append(el("div", "cm-ball", `${takerName}（${takerSide}）のキックオフ`));
  }, async (box, skipped) => {
    await wait(BEAT.kickoffRead + (half === 2 ? BEAT.kickoffSwap : 0));
    if (skipped()) return;
    whistle(box, "ピッ");
    box.classList.add("is-go");
    await wait(BEAT.blow);
  });
}

/* ------------------------------------------------------------ ゴール */

/**
 * いま入ったゴールの状況を、自分のチームから見た一言にする。
 *
 * 🔑 自分が取ったときだけ言い分ける。相手に取られたほうを細かく言い分けても
 *    （「追いつかれた」「突き放された」）**落ち込むだけで情報は増えない**ので「失点」で止める。
 * 🔴 1点では「逆転」は起こらない。負けている側が1点入れても、届くのは同点まで
 *    （整数なので `mine-1 < theirs` と `mine > theirs` は同時に成り立たない）。
 *    だから「逆転」という語はここに出さない。
 */
function goalWord(scoredByMe: boolean, mine: number, theirs: number): string {
  if (!scoredByMe) return "失点";
  if (mine === 1 && theirs === 0) return "先制";
  if (mine === theirs) return "同点";
  if (mine < theirs) return "反撃";
  return mine - theirs === 1 ? "勝ち越し" : "追加点";
}

/**
 * ゴールの瞬間。
 *
 * @param scorer    入ったゴールそのもの（時間・チーム・得点者）
 * @param home/away **そのゴールが入ったあと**のスコア
 *
 * 🔑 他の3つより短い（合計 1.5秒以内）。試合が何度も止まると見ていられない。
 * 🔑 幕は薄くする。盤の上で喜んでいる絵が主役。
 */
export function goal(sides: Sides, scorer: Scorer, home: number, away: number): Promise<void> {
  /* 🔴 どちらのチームが入れたのか分からない入力は**幕を開ける前に弾く**。
        「自分でなければ相手」で済ませると、名前の取り違えがそのまま
        「失点」と表示されて嘘になる。
        🔴 `curtain` に入ってから投げてはいけない（開いた幕が残りかねない）ので、ここで見る。 */
  if (scorer.team !== sides.home && scorer.team !== sides.away) {
    throw new Error(`得点したチーム「${scorer.team}」が ${sides.home} / ${sides.away} のどちらでもない`);
  }
  const { mine, theirs } = mySide(sides, home, away);
  const myName = sides.myIndex === 0 ? sides.home : sides.away;
  const scoredByMe = scorer.team === myName;
  const word = goalWord(scoredByMe, mine, theirs);

  /* 🔑 色は `is-win` / `is-lose` に任せる（`.cm-result` が緑と赤に塗り分く）。
        演出のためだけに新しい見た目を増やさない */
  return curtain(`cm-goal ${scoredByMe ? "is-win" : "is-lose"}`, (box) => {
    box.append(el("div", "cm-half", "ゴール"));
    box.append(el("div", "cm-result", word));

    const who = el("div", "cm-scorer");
    who.append(el("span", "cm-scorer-time", scorer.time),
               el("span", "cm-scorer-name", `${scorer.player}（${scorer.team}）`));
    box.append(who);

    box.append(scoreRow(sides, home, away));
  }, async (box, skipped) => {
    await wait(BEAT.goalRead);
    if (skipped()) return;
    box.classList.add("is-go");
    await wait(BEAT.goalOut);
  }, { dim: "rgba(10, 26, 48, .34)" });
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
    box.append(el("div", "cm-half", "前半終了"));
    box.append(scoreRow(sides, home, away));

    const list = el("div", "cm-scorers");
    if (scorers.length === 0) {
      list.append(el("div", "cm-note", "前半の得点はありません"));
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
    const go = el("button", "btn btn-primary btn-big", "後半をはじめる");
    (go as HTMLButtonElement).type = "button";
    box.append(go);
    /* 🔑 押せることを**書いておく**。ここは自動で進まない唯一の演出なので、
          書かないと「止まった」と思われる */
    box.append(el("div", "cm-note", "画面のどこを押しても後半へ進みます"));
    go.focus();
    await new Promise<void>((done) => {
      /* 🔴 **どちらの道で進んでも見張りを止める。** ボタンで進んだときに
            止め忘れると、100ms ごとのタイマーがページを閉じるまで回り続け、
            試合を重ねるほど無駄な起床が積もる。 */
      const poll = window.setInterval(() => {
        if (skipped()) finish();
      }, 100);
      const finish = (): void => {
        window.clearInterval(poll);
        done();
      };
      go.addEventListener("click", finish);
    });
  });
}

/* ------------------------------------------------------------ 試合終了 */

/**
 * 試合終了のひとこと。
 *
 * 🔑 使うのは**スコアから分かることだけ**。「惜しかった」「相手が強かった」のような
 *    持っていない情報は書かない。無い話を混ぜると、他の表示も疑われる。
 * 🔑 勝ち点は `src/sim/league.ts` の値を読む。ここに 3 と 1 を書くと、
 *    規則を変えたときにこの文だけが嘘になる。
 */
function fullTimeLine(mine: number, theirs: number): string {
  const diff = Math.abs(mine - theirs);
  if (mine > theirs) {
    if (theirs === 0) return `無失点で守りきった ${diff}点差の勝利。勝ち点${WIN_POINTS}`;
    if (diff >= 3) return `${diff}点差の完勝。勝ち点${WIN_POINTS}`;
    if (diff === 1) return `1点差を守りきりました。勝ち点${WIN_POINTS}`;
    return `${diff}点差の勝利。勝ち点${WIN_POINTS}`;
  }
  if (mine < theirs) {
    if (mine === 0) return `無得点のまま ${diff}点差。攻め手を組み直しましょう`;
    if (diff >= 3) return `${diff}点差の完敗。立て直して次へ`;
    return `${diff}点差。あと一歩でした`;
  }
  if (mine === 0) return `0-0 の我慢比べ。勝ち点${DRAW_POINTS}を分け合いました`;
  return `${mine}点を取り合っての引き分け。勝ち点${DRAW_POINTS}`;
}

export function fullTime(sides: Sides, home: number, away: number): Promise<void> {
  const { mine, theirs } = mySide(sides, home, away);
  /* 🔑 「勝ち／負け」より言い切った言葉にする。90分の結末がただの名詞だと手応えが残らない */
  const word = mine > theirs ? "勝利" : mine < theirs ? "敗戦" : "引き分け";
  const tone = mine > theirs ? "is-win" : mine < theirs ? "is-lose" : "is-draw";

  return curtain(`cm-full-time ${tone}`, (box) => {
    box.append(el("div", "cm-half", "試合終了"));
    box.append(scoreRow(sides, home, away));
  }, async (box, skipped) => {
    /* 🔑 試合終了は**長い笛**。前半終了の短い笛と区別が付く */
    whistle(box, "ピーーーッ");

    const result = el("div", "cm-result", word);
    const note = el("div", "cm-note", fullTimeLine(mine, theirs));

    /* 🔴 動きを減らす設定のときは**一度に出す**。段ごとに 120ms へ詰めると、
          出した瞬間に消えて読めない。「動きを減らす」は「速く流す」ではない。
          （結果そのものは次の結果画面に残るので、ここで読み切れなくても情報は欠けない） */
    if (reduced()) {
      box.append(result, note);
      await hold(BEAT.reducedHold);
      return;
    }

    /* 🔑 笛 → 結果 → ひとこと、と段を追う。全部いっしょに出すと、
          どこを見ればいいか分からないまま幕が引ける */
    await wait(BEAT.fullWhistle);
    if (skipped()) return;
    box.append(result);
    await wait(BEAT.fullWord);
    if (skipped()) return;
    box.append(note);
    await wait(BEAT.fullNote);
  });
}

/** 出ている演出を今すぐ畳む（「結果まで飛ばす」用） */
export function cancel(): void {
  closeCurrent?.();
}
