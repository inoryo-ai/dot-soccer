/**
 * 画面の組み立てと操作。
 *
 * 🔴 ここにもゲームの規則を書かない。判定は必ず `src/sim/`（入口は `./api.ts`）。
 *    ここがやるのは「返ってきた値を並べる」ことと「押されたら渡す」ことだけ。
 */

import * as api from "./api.ts";
import type { Bootstrap, PlayNextResult, PlayerView, View } from "./api.ts";
import type { MatchEvent, MatchStatsOut } from "../sim/engine.ts";
import * as Board from "./board.ts";
import * as Ceremony from "./ceremony.ts";
import * as City from "./city.ts";
import * as Fx from "./fx.ts";
import * as Pitch from "./pitch.ts";
import * as Room from "./room.ts";

const SAVE_KEY = "dot-soccer-save-v1";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`画面に #${id} が無い（index.html と食い違っている）`);
  return n as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null,
                                                   text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

let boot: Bootstrap | null = null;        // 変わらない情報（カード一覧・選択肢）
let view: View | null = null;             // いまの状態
let plan: Record<string, number> = {};    // 初期育成の配分
let selectedPlayer: number | null = null;
let selectedCards: string[] = [];
let matchData: PlayNextResult | null = null;
let swapMode = false;                     // 先発と控えの入れ替え中か
let swapFrom: number | null = null;       // 入れ替える先発の番号
let lastScore: string | null = null;      // 得点の演出を出すため、直前のスコアを覚える

const B = (): Bootstrap => {
  if (boot === null) throw new Error("起動前に画面を描こうとした");
  return boot;
};
const V = (): View => {
  if (view === null) throw new Error("ゲームが始まる前に画面を描こうとした");
  return view;
};

/* ------------------------------------------------------------------ 共通 */

/**
 * 画面を1つだけ出す。
 *
 * 🔑 上の表示板（`#hudBar`）は画面の外にある1本なので、ここでまとめて出し入れする
 *    （2026-10-02 の街ハブ化）。タイトルとチーム作成では、まだチームが無いので出さない。
 */
/* 🔑 試合は全画面なので、上の表示板も出さない（2026-10-03）。
      試合中に見たいのは得点板であって、順位や節ではない。 */
const NO_HUD = new Set(["boot", "setup", "match"]);

/**
 * 画面ごとの背景の絵（`web/bg/` に置いたもの）。
 *
 * 🔴 ここに無い画面は、従来どおり `room.ts` が手続きで描く（D-26）。
 *    絵が用意できた画面から1行ずつ移していける。
 * 🔑 選手とピッチは**絵にしない**。商店街で買う見た目で色を差し替える仕様なので、
 *    焼き込むと着せ替えが機能しなくなる。
 */
const BG_PHOTO: Record<string, string> = {};

/**
 * デザイン由来の**動く背景**を使う画面（D-28）。値は `<stadium-scene>` の `screen` 属性。
 *
 * 🔑 `title` / `menu` / `result` は同じ「引きの構え」。`menu` だけ少しぼかして暗くなるので、
 *    手前にパネルを置く画面（チーム作成・サッカー場）に向く。
 * 🔴 ここに無い画面は従来どおり `room.ts` が手続きで描く。
 *    街・商店街・事務所の部品（`city.js` / `shop.js` / `office.js`）はデザイン側に発注済み。
 * 🔴 `match` はまだ入れていない。デザインの `match` は**自前のピッチの絵も描く**ので、
 *    本物の試合描画と重なる。組み合わせ方を決めてから入れる。
 */
const BG_SCENE: Record<string, string> = {
  boot: "title",
  setup: "menu",
  stadium: "result",
  /* 🔑 `match` は上の 396/1080 がスタンド・屋根・LEDボードで、下は何も描かない
        （デザイン側の `grassTop = H`）。そこへ本物の盤を敷く。 */
  match: "match",
};

function showScreen(id: string): void {
  for (const s of document.querySelectorAll(".screen")) s.classList.remove("is-on");
  $(id).classList.add("is-on");
  $("hudBar").hidden = NO_HUD.has(id);
  /* 施設の背景。
     🔴 **絵があればそれを敷き、無ければ手続きで描く**（2026-10-03 D-26）。
        絵と手続きが同時に出ることは無い。差し替え口をここ1か所にしておくと、
        絵が増えるたびに `BG_PHOTO` へ1行足すだけで済む。 */
  const scene = $("bgScene");
  const photo = $("bgPhoto");
  const room = $<HTMLCanvasElement>("roomCanvas");
  const scr = BG_SCENE[id];
  const src = BG_PHOTO[id];
  scene.hidden = scr === undefined;
  photo.hidden = src === undefined;
  if (scr !== undefined) {
    $("bgSceneEl").setAttribute("screen", scr);
    room.hidden = true;
  } else if (src !== undefined) {
    photo.style.backgroundImage = `url("${src}")`;
    room.hidden = true;
  } else {
    room.hidden = !Room.draw(room, id);
  }
  window.scrollTo(0, 0);
}

function showError(message: string, title?: string): void {
  $("errorTitle").textContent = title || "うまくいきませんでした";
  $("errorMsg").textContent = message;
  $("errorBox").hidden = false;
}

/** ゲームを呼ぶ。日本語の理由が返ってきたらそれを出し、それ以外は原因ごと出す。 */
function call<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof api.GameError) {
      showError(e.message);
    } else {
      /* 🔴 握りつぶさない。**押しても何も起きない画面**が一番たちが悪い */
      console.error("[dot-soccer]", e);
      showError(e instanceof Error ? e.message : String(e), "想定していない失敗です");
    }
    return null;
  }
}

function minuteText(tick: number): string {
  const m = Math.floor(tick / 60);
  const s = tick % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* -------------------------------------------------------------- セーブ */

function saveGame(quiet: boolean): void {
  const data = call(() => api.saveDict());
  if (!data) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    if (!quiet) $("saveMsg").textContent = "保存しました。";
  } catch (e) {
    /* 🔴 保存できないことを黙らない。閉じたら消えることを伝える */
    $("saveMsg").textContent = "保存できませんでした。この画面を閉じると進みが消えます。";
    console.error("[dot-soccer] 保存", e);
  }
}

function hasSave(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

/* -------------------------------------------------- チーム作成の初期育成 */

function renderPlanRows(): void {
  const rows = $("planRows");
  rows.textContent = "";
  for (const [key, card] of Object.entries(B().cards)) {
    const row = el("div", "plan-row");
    row.append(el("span", null, card.label));
    const range = el("input");
    range.type = "range";
    range.min = "0";
    range.max = String(B().trainings_per_player);
    range.value = String(plan[key] || 0);
    range.addEventListener("input", () => {
      plan[key] = Number(range.value);
      updatePlanTotal();
    });
    const out = el("output", null, String(plan[key] || 0));
    out.dataset.key = key;
    row.append(range, out);
    rows.append(row);
  }
  updatePlanTotal();
}

function updatePlanTotal(): void {
  const total = Object.values(plan).reduce((a, b) => a + b, 0);
  const target = B().trainings_per_player;
  $("planUsed").textContent = String(total);
  $("planTotal").textContent = String(target);
  $("planTotalTarget").textContent = String(target);
  for (const out of $("planRows").querySelectorAll("output")) {
    out.textContent = String(plan[out.dataset.key ?? ""] || 0);
  }
  for (const r of $("planRows").querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const key = r.parentElement?.querySelector("output")?.dataset.key ?? "";
    r.value = String(plan[key] || 0);
  }
  /* 🔴 「ちょうど20回」でなければ開幕させない。足りないとAIだけ育った状態で始まる */
  const ok = total === target;
  $<HTMLButtonElement>("startBtn").disabled = !ok;
  $("planWarn").textContent = ok ? ""
    : (total < target ? `（あと ${target - total} 回）` : `（${total - target} 回 多い）`);
}

function renderPlanPresets(): void {
  const box = $("planPresets");
  box.textContent = "";
  for (const [name, preset] of Object.entries(B().preset_plans)) {
    const chip = el("button", "chip", name);
    chip.type = "button";
    chip.addEventListener("click", () => {
      plan = { ...preset };
      updatePlanTotal();
    });
    box.append(chip);
  }
}

/* ---------------------------------------------------------------- ホーム */

function renderHome(): void {
  const v = V();
  $("hudTeam").textContent = v.team;
  $("hudRank").textContent = `${v.rank}位`;
  $("hudRound").textContent = v.season_finished
    ? `${v.season}シーズン目 — 全${v.total_rounds}節 終了`
    : `${v.season}シーズン目 第${v.round + 1}節 / ${v.total_rounds}`;

  const fx = $("nextFixture");
  fx.textContent = "";
  if (v.season_finished) {
    fx.append(el("span", null, "全節終了。シーズンを締めます"));
    $("playBtn").textContent = "シーズンを締める";
  } else if (v.next_fixture) {
    const [home, away] = v.next_fixture;
    fx.append(el("span", null, home), el("span", "vs", "vs"), el("span", null, away));
    $("playBtn").textContent = "キックオフ";
  }

  const stock = $("cardStock");
  stock.textContent = "";
  const keys = Object.keys(v.cards);
  if (keys.length === 0) {
    stock.append(el("p", "stock-empty", "まだありません。試合で課題が出るともらえます。"));
  } else {
    for (const key of keys) {
      const s = el("div", "stock");
      s.append(el("span", null, B().cards[key]!.label), el("b", null, `×${v.cards[key]}`));
      stock.append(s);
    }
  }

  renderSquad();
  renderTacticsForm();
  renderStandings();
  renderFixtures();
  renderHistory();
}

/* -------------------------------------------------------------- 商店街 */

/**
 * 商店街の品ぞろえ。
 *
 * 🔴 **いまは品物を並べるところまで**（2026-10-02）。買う処理はまだ無い。
 *    お金と持ち物は `src/sim/career.ts`（規則層）に置く必要があり、
 *    そこへ手を入れると**正解データの作り直し**（D-18 と同じ手順）が要るため、
 *    街の導線とは分けて次の段で入れる。
 * 🔑 「準備中」と出すだけの空の店にしない。何が買えるようになるのかが見えていれば、
 *    行き止まりではなく**これから開く店**に見える。
 * 🔑 効果はすべて見た目だけ（要件 GD-03）。ここに能力を上げる品物を混ぜない。
 */
const SHOP_GOODS: { name: string; note: string; yen: number }[] = [
  { name: "ユニフォーム", note: "青 / 赤 / 緑 / 縞 — ピッチのドット絵に出る", yen: 3000 },
  { name: "ゴールキーパー着", note: "GK だけ別の色にできる", yen: 3000 },
  { name: "髪型・髪色", note: "選手ごとに変えられる", yen: 1500 },
  { name: "アクセサリー", note: "ヘアバンド・リストバンドなど", yen: 5000 },
];

function renderShop(): void {
  const box = $("shopList");
  box.textContent = "";
  for (const g of SHOP_GOODS) {
    const row = el("div", "shop-item");
    const left = el("div", "shop-main");
    left.append(el("div", "shop-name", g.name), el("div", "shop-note", g.note));
    const right = el("div", "shop-buy");
    right.append(el("div", "shop-yen", `${g.yen.toLocaleString("ja-JP")}円`));
    const btn = el("button", "btn", "準備中");
    btn.type = "button";
    btn.disabled = true;
    right.append(btn);
    row.append(left, right);
    box.append(row);
  }
}

/* ---------------------------------------------------------------- 選手 */

function renderSquad(): void {
  const list = $("squadList");
  list.textContent = "";
  for (const p of V().squad) {
    const btn = el("button", `player${p.starter ? "" : " is-bench"}`);
    btn.type = "button";
    if (selectedPlayer === p.index) btn.classList.add("is-on");

    const pos = el("span", "pos", p.position);
    pos.dataset.pos = p.position;
    const main = el("div", "player-main");
    main.append(el("div", "player-name", p.name),
                el("div", "player-type", `${p.type}${p.starter ? "" : "（控え）"}`));
    const total = Object.values(p.visible).reduce((a, b) => a + b, 0);
    const abil = el("div", "player-abil");
    abil.append(el("div", null, `合計 ${total}`),
                /* 🔑 生まれ持った性質。特訓では動かないので「この選手はこういう選手」
                   という読み方になる。受け持ちの広さと、どこまで見えているか */
                el("div", "player-trait", `範囲 ${p.roam_m}m / 視野 ${p.vision_m}m`));

    btn.append(pos, main, abil);
    if (swapMode && swapFrom === p.index) btn.classList.add("is-swap");
    btn.addEventListener("click", () => (swapMode ? pickForSwap(p) : selectPlayer(p.index)));
    list.append(btn);
  }
}

function pickForSwap(p: PlayerView): void {
  /* 🔑 2段階にする。1人目に先発、2人目に控えを選ばせる。
     一覧から2人選ぶだけなので、番号を打たせない */
  if (swapFrom === null) {
    if (!p.starter) {
      $("swapMsg").textContent = "まず外す先発を選んでください。";
      return;
    }
    swapFrom = p.index;
    $("swapMsg").textContent = `${p.name} と入れ替える控えを選んでください。`;
    renderSquad();
    return;
  }
  if (p.starter) {
    $("swapMsg").textContent = "入れる控えを選んでください（やめるならもう一度ボタンを押す）。";
    return;
  }
  const from = swapFrom;
  const out = call(() => api.swapStarter(from, p.index));
  if (!out) {
    endSwap();
    return;
  }
  view = out;
  $("swapMsg").textContent = "入れ替えました。";
  endSwap();
  renderHome();
  saveGame(true);
}

function endSwap(): void {
  swapMode = false;
  swapFrom = null;
  $("swapBtn").textContent = "先発と控えを入れ替える";
  renderSquad();
}

function selectPlayer(index: number): void {
  selectedPlayer = index;
  selectedCards = [];
  const p = V().squad.find((x) => x.index === index);
  if (p === undefined) return;
  $("trainWho").textContent = `${p.name}（${p.type}）`;
  $("trainPanel").hidden = false;
  $("trainResult").hidden = true;
  renderSquad();
  renderTrainCards();
}

function renderTrainCards(): void {
  const box = $("trainCards");
  box.textContent = "";
  const owned = V().cards;
  const keys = Object.keys(owned);
  if (keys.length === 0) {
    box.append(el("p", "note", "カードがありません。試合をすると課題からもらえます。"));
  }
  for (const key of keys) {
    const card = B().cards[key]!;
    const picked = selectedCards.filter((k) => k === key).length;
    const chip = el("button", `chip${picked ? " is-on" : ""}`,
                    `${card.label} ×${owned[key]}${picked ? `（選択${picked}）` : ""}`);
    chip.type = "button";
    chip.addEventListener("click", () => toggleCard(key));
    box.append(chip);
  }
  const hint = $("trainHint");
  if (selectedCards.length === 2) {
    hint.textContent = "2枚＝スペシャル。両方の効果が1.5倍になります。";
  } else if (selectedCards.length === 1) {
    hint.textContent = "もう1枚選ぶとスペシャルになります（相反する組は選べません）。";
  } else {
    hint.textContent = "カードを1枚か2枚選んでください。";
  }
  $<HTMLButtonElement>("trainBtn").disabled = selectedCards.length === 0;
}

function toggleCard(key: string): void {
  const at = selectedCards.indexOf(key);
  const owned = V().cards[key] || 0;
  if (at >= 0) {
    selectedCards.splice(at, 1);
  } else if (selectedCards.length < 2) {
    if (selectedCards.filter((k) => k === key).length >= owned) {
      showError(`「${B().cards[key]!.label}」の所持が足りません`);
      return;
    }
    /* 🔴 相反する組はここで止める。ゲーム側でも弾かれるが、
       押してから日本語で断るより、押す前に分かるほうがよい */
    const pair = [...selectedCards, key].sort();
    const forbidden = B().forbidden_pairs.some(
      (f) => f.length === 2 && f[0] === pair[0] && f[1] === pair[1]);
    if (forbidden) {
      showError(`「${B().cards[pair[0]!]!.label}」と「${B().cards[pair[1]!]!.label}」は`
                + "同時に使えません（効果が打ち消し合います）");
      return;
    }
    selectedCards.push(key);
  }
  renderTrainCards();
}

function doTrain(): void {
  const who = selectedPlayer;
  if (who === null) return;
  const cards = [...selectedCards];
  const out = call(() => api.train(who, cards));
  if (!out) return;
  view = out.view;
  const r = out.result;
  const box = $("trainResult");
  box.textContent = "";
  box.hidden = false;
  box.append(el("div", null, `${out.label} — ${r.player}`));

  /* 🔴 以前は `r.visible` / `r.hidden` を読んでいたが、特訓の結果にその項目は**無い**。
        Python 版の画面ではここで例外になり、特訓はかかったのに画面が止まり、
        セーブもされなかった（TypeScript にして型の検査で見つかった・2026-10-02）。
        いまは「変えた項目（deltas）」の前後を、特訓後の選手一覧から読む。 */
  const after = view.squad.find((p) => p.index === who);
  const ups: string[] = [];
  /* 🔑 飛ばす数字は **実際に動いた差**（now - before）にする。`r.deltas` は「かけようとした量」で、
        上限に当たると実際はそこまで伸びない。要求量を飛ばすと、数字だけ増えて表は変わらない
        ＝嘘になる。表に出している `before→now` と必ず同じ出どころにする。 */
  const moved: number[] = [];
  for (const k of Object.keys(r.deltas)) {
    const before = r.visible_before[k] ?? r.hidden_before[k];
    const now = after?.visible[k] ?? after?.hidden[k];
    if (before !== undefined && now !== undefined && now !== before) {
      ups.push(`${k} ${before}→${now}`);
      moved.push(now - before);
    }
  }
  box.append(el("div", "up", ups.length > 0 ? ups.join(" / ") : "（上限に達していて伸びませんでした）"));
  const typeChanged = r.before !== r.after;
  box.append(el("div", typeChanged ? "changed" : "",
                typeChanged
                  ? `★ タイプが変わった: ${r.before} → ${r.after}`
                  : `タイプ: ${r.after}（変化なし）`));

  /* 🔴 数字が静かに変わるだけでは、特訓が効いたことに気づけない（`fx.ts` の頭に理由）。
        伸びたぶんをその場から飛ばし、タイプが変わった時だけ帯と粒を足す。
        🔑 演出は見た目だけ。ここで結果を作らない（上の `moved` は表と同じ値） */
  for (const [i, d] of moved.entries()) {
    Fx.floatNum(`${d > 0 ? "+" : ""}${d}`, box, i);
  }
  if (typeChanged) {
    Fx.ribbon(`${r.player} は ${r.after} になった！`);
    Fx.sparks(box);
  }

  selectedCards = [];
  renderHome();
  renderTrainCards();
  saveGame(true);
}

/* ---------------------------------------------------------------- 戦術 */

const MANAGER_LABELS: Record<string, [string, string]> = {
  style: ["守備的", "攻撃的"],
  rigidity: ["弾力的", "徹底的"],
  substitution: ["消極的", "積極的"],
  selection: ["安定感", "期待感"],
};

function renderTacticsForm(): void {
  const v = V();
  fillSelect($<HTMLSelectElement>("tFormation"), B().formations, v.tactics.formation);
  fillSelect($<HTMLSelectElement>("tAttitude"), B().attitudes, v.tactics.attitude);
  $<HTMLInputElement>("tLine").value = String(v.tactics.line_height);
  $<HTMLInputElement>("tWidth").value = String(v.tactics.zone_width);
  $("tLineVal").textContent = String(v.tactics.line_height);
  $("tWidthVal").textContent = String(v.tactics.zone_width);

  const rows = $("managerRows");
  rows.textContent = "";
  for (const [key, [left, right]] of Object.entries(MANAGER_LABELS)) {
    const f = el("div", "field");
    const label = el("label", null, `${left} ↔ ${right}`);
    label.htmlFor = `mg-${key}`;
    const range = el("input");
    range.type = "range";
    range.id = `mg-${key}`;
    range.min = "-2";
    range.max = "2";
    range.value = String(v.manager[key as keyof View["manager"]]);
    range.dataset.key = key;
    f.append(label, range);
    rows.append(f);
  }

  renderPolicyRows();
  $("policyMax").textContent = String(B().policy_max_rules);
  renderBoard();
}

/**
 * 配置盤。**動かした瞬間に `src/sim/` へ入れて、返ってきた値で描き直す。**
 *
 * 🔑 盤の中に「いまの配置」を貯めない。貯めると、規則に弾かれた動きが
 *    盤の上だけ残って「画面では動いているのに試合では元の位置」になる。
 */
function renderBoard(): void {
  Board.render($("lineupBoard"), V().lineup, {
    commit(spots) {
      const out = call(() => api.setLineup(spots));
      /* 弾かれたら盤を描き直して**元の位置に戻す**（嘘の表示を残さない） */
      if (!out) { renderBoard(); return; }
      view = out;
      $("lineupMsg").textContent = "配置を変えました。";
      saveGame(true);
    },
    say(text) { $("lineupMsg").textContent = text; },
  });
}

function fillSelect(node: HTMLSelectElement, options: readonly string[], current: string): void {
  node.textContent = "";
  for (const o of options) {
    const opt = el("option", null, o);
    opt.value = o;
    if (o === current) opt.selected = true;
    node.append(opt);
  }
}

let policyDraft: { condition: string; action: string }[] = [];

function renderPolicyRows(): void {
  const rows = $("policyRows");
  rows.textContent = "";
  policyDraft.forEach((rule, i) => {
    const row = el("div", "field-row");
    const c = el("div", "field");
    const cs = el("select");
    fillSelect(cs, B().policy_conditions, rule.condition);
    cs.addEventListener("change", () => { policyDraft[i]!.condition = cs.value; });
    c.append(el("label", null, `条件 ${i + 1}`), cs);

    const a = el("div", "field");
    const as = el("select");
    fillSelect(as, B().policy_actions, rule.action);
    as.addEventListener("change", () => { policyDraft[i]!.action = as.value; });
    a.append(el("label", null, "行動"), as);

    const del = el("button", "btn", "消す");
    del.type = "button";
    del.addEventListener("click", () => {
      policyDraft.splice(i, 1);
      renderPolicyRows();
    });

    row.append(c, a, del);
    rows.append(row);
  });
  $<HTMLButtonElement>("policyAdd").disabled = policyDraft.length >= B().policy_max_rules;
}

function saveTactics(): void {
  let out = call(() => api.setTactics(Number($<HTMLInputElement>("tLine").value),
                                      Number($<HTMLInputElement>("tWidth").value),
                                      $<HTMLSelectElement>("tAttitude").value,
                                      $<HTMLSelectElement>("tFormation").value));
  if (!out) return;
  const m: Record<string, number> = {};
  for (const r of $("managerRows").querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    m[r.dataset.key ?? ""] = Number(r.value);
  }
  out = call(() => api.setManager(m.style ?? 0, m.rigidity ?? 0, m.substitution ?? 0,
                                  m.selection ?? 0));
  if (!out) return;
  out = call(() => api.setPolicy(policyDraft));
  if (!out) return;
  view = out;
  $("tacticsMsg").textContent = "決めました。";
  renderHome();
  saveGame(true);
}

/* ------------------------------------------------------------ 順位・日程 */

function renderStandings(): void {
  const v = V();
  const box = $("standings");
  box.textContent = "";
  const table = el("table");
  const head = el("tr");
  for (const h of ["順", "チーム", "試", "勝", "分", "敗", "得", "失", "差", "点"]) {
    head.append(el("th", h === "チーム" ? "name" : null, h));
  }
  /* 🔑 `append()` は何も返さない。戻り値を辿ると undefined になる（実際に踏んだ） */
  const thead = el("thead");
  thead.append(head);
  table.append(thead);
  const body = el("tbody");
  for (const r of v.standings) {
    const tr = el("tr");
    if (r.team === v.team) tr.classList.add("is-me");
    tr.append(el("td", null, String(r.rank)), el("td", "name", r.team),
              el("td", null, String(r.played)), el("td", null, String(r.w)),
              el("td", null, String(r.d)), el("td", null, String(r.l)),
              el("td", null, String(r.gf)), el("td", null, String(r.ga)),
              el("td", null, (r.gd > 0 ? "+" : "") + r.gd), el("td", null, String(r.points)));
    body.append(tr);
  }
  table.append(body);
  box.append(table);
}

function renderFixtures(): void {
  const v = V();
  const box = $("fixtures");
  box.textContent = "";
  if (v.remaining.length === 0) {
    box.append(el("p", "note", "残りの試合はありません。"));
    return;
  }
  const table = el("table");
  const body = el("tbody");
  v.remaining.forEach((round, i) => {
    const mine = round.find((f) => f.includes(v.team));
    const tr = el("tr");
    if (i === 0) tr.classList.add("is-me");
    tr.append(el("td", null, `第${v.round + i + 1}節`),
              el("td", "name", mine ? `${mine[0]} vs ${mine[1]}` : "—"));
    body.append(tr);
  });
  table.append(body);
  box.append(table);
}

function renderHistory(): void {
  const v = V();
  const panel = $("historyPanel");
  if (!v.history.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const box = $("history");
  box.textContent = "";
  const table = el("table");
  const body = el("tbody");
  for (const h of v.history) {
    const tr = el("tr");
    tr.append(el("td", null, `${h.season}シーズン目`), el("td", "name", `${h.rank}位`));
    body.append(tr);
  }
  table.append(body);
  box.append(table);
}

/* ---------------------------------------------------------------- 試合 */

function startMatch(): void {
  if (V().season_finished) {
    const out = call(() => api.finishSeason());
    if (!out) return;
    view = out.view;
    renderHome();
    saveGame(true);
    showError(`${out.summary.season}シーズン目は ${out.summary.rank}位でした。`
              + `${view.season}シーズン目が始まります。`, "シーズン終了");
    return;
  }

  const out = call(() => api.playNext());
  if (!out) return;
  matchData = out;
  view = out.view;
  saveGame(true);

  /* 🔑 ピッチの色は「ホーム＝黄／アウェー＝青」で固定する（盤面が読みやすい）。
     自分のチームがどちらかは**名前の前の★**で示す。色まで入れ替えると、
     試合ごとに自分の色が変わって盤面が読めなくなる。 */
  $("sbHome").textContent = (out.my_index === 0 ? "★ " : "") + out.teams[0];
  $("sbAway").textContent = out.teams[1] + (out.my_index === 1 ? " ★" : "");
  $("sbScore").textContent = "0 - 0";
  $("sbClock").textContent = "0:00";
  $("ticker").textContent = "キックオフ";
  $("matchResult").hidden = true;
  $("mcPlay").textContent = "一時停止";
  showScreen("match");

  lastScore = null;
  skipAll = false;
  const sides: Ceremony.Sides = {
    home: out.teams[0], away: out.teams[1], myIndex: out.my_index,
  };
  Pitch.load(out.replay, out.events, out.teams[0], {
    /* 🔴 前半の終わりで一度止めて、ハーフタイム → 後半のキックオフ → 再生、の順に進める。
          止めずに通すと、45分の区切りが**数字が変わるだけ**になって気づけない。 */
    onHalfTime: () => {
      const s = Pitch.state();
      void Ceremony.halfTime(sides, s.home, s.away, scorersUpTo(out.events, s.tick))
        .then(() => Ceremony.kickoff(2, sides))
        .then(() => Pitch.resume());
    },
    onUpdate: (s) => {
      /* 🔴 スコアが動いた瞬間に知らせる。数字が増えるだけだと見逃す */
      const now = `${s.home}-${s.away}`;
      if (lastScore !== null && lastScore !== now) showGoal(s.event);
      lastScore = now;
      $("sbScore").textContent = `${s.home} - ${s.away}`;
      $("sbClock").textContent = minuteText(s.tick);
      const t = $("ticker");
      t.textContent = "";
      if (s.event) {
        t.append(el("span", "t-time", s.event.time));
        const label = `${s.event.type}${s.event.player ? ` — ${s.event.player}` : ""}`
                    + `${s.event.detail ? ` ${s.event.detail}` : ""}`;
        t.append(el("span", s.event.type === "ゴール" ? "t-goal" : null, label));
      } else {
        t.append(el("span", null, "キックオフ"));
      }
    },
    onFinish: () => {
      /* 🔑 「結果まで飛ばす」を押した人には演出も出さない。
            飛ばしたのに幕が出るのは、押した意味を無視している */
      if (skipAll) { showMatchResult(); return; }
      const s = Pitch.state();
      void Ceremony.fullTime(sides, s.home, s.away).then(showMatchResult);
    },
  });

  /* 🔑 キックオフの演出のあいだは止めておく。
        笛の前に試合が動き出すと「もう始まっていた」ことになる */
  Pitch.pause();
  void Ceremony.kickoff(1, sides).then(() => Pitch.resume());
}

/** `tick` までに入ったゴールを、ハーフタイムの一覧に出す形で拾う */
function scorersUpTo(events: MatchEvent[], tick: number): Ceremony.Scorer[] {
  const out: Ceremony.Scorer[] = [];
  for (const e of events) {
    if (e.tick > tick) break;
    if (e.type !== "ゴール") continue;
    out.push({ time: e.time, team: e.team, player: e.player ?? "—" });
  }
  return out;
}

/** 「結果まで飛ばす」を押したか。押したら節目の演出も出さない */
let skipAll = false;
let goalTimer = 0;

function showGoal(ev: MatchEvent | null): void {
  const box = $("goalFlash");
  $("goalWho").textContent = ev && ev.player ? `${ev.player}（${ev.team}）` : "";
  box.hidden = false;
  /* 🔑 粒は枠が出てから撒く。先に撒くと、まだ幅のない要素の中心（＝画面の隅）から飛ぶ */
  Fx.sparks(box, 12);
  clearTimeout(goalTimer);
  goalTimer = window.setTimeout(() => { box.hidden = true; }, 2600);
}

function showMatchResult(): void {
  if (!matchData || !$("matchResult").hidden) return;
  const out = matchData;

  const box = $("statTable");
  box.textContent = "";
  const table = el("table");
  const head = el("tr");
  head.append(el("th", "name", ""), el("th", null, out.teams[0]), el("th", null, out.teams[1]));
  const thead = el("thead");
  thead.append(head);
  table.append(thead);
  const body = el("tbody");
  const ROWS: [string, keyof MatchStatsOut][] = [
    ["シュート", "shots"], ["得点", "goals"], ["パス", "passes"],
    ["パス成功率", "pass_success_pct"], ["ボール奪取", "tackles_won"],
    ["裏を取られた", "beaten_behind"], ["走行距離(km)", "distance_km"],
    ["支配率", "possession_pct"], ["息切れ人数", "stamina_low_players"],
  ];
  for (const [label, key] of ROWS) {
    const tr = el("tr");
    tr.append(el("td", "name", label),
              el("td", null, String(out.stats[0]![key])),
              el("td", null, String(out.stats[1]![key])));
    body.append(tr);
  }
  table.append(body);
  box.append(table);

  const aw = $("awarded");
  aw.textContent = "";
  if (out.awarded.length === 0) {
    aw.append(el("p", "note", "今回は課題が出ませんでした。"));
  } else {
    for (const a of out.awarded) {
      const chip = el("div", "stock award");
      chip.append(el("div", "award-name", a.label), el("div", "award-why", a.issue));
      aw.append(chip);
    }
  }

  const ot = $("others");
  ot.textContent = "";
  const t2 = el("table");
  const b2 = el("tbody");
  for (const o of out.others) {
    const tr = el("tr");
    tr.append(el("td", "name", `${o.home} ${o.home_goals} - ${o.away_goals} ${o.away}`));
    b2.append(tr);
  }
  t2.append(b2);
  ot.append(t2);

  $("matchResult").hidden = false;
  $("matchResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------------------------------------ 立ち上げ */

function main(): void {
  Pitch.attach($<HTMLCanvasElement>("pitch"));
  Pitch.attachMini($<HTMLCanvasElement>("miniMap"));

  /* 🔑 以前は Pyodide（ブラウザで Python を動かす仕組み、約10MB）を読み込んでいた。
        TypeScript になったので待つものは無い。表示だけ一瞬で満たす */
  $("bootFill").style.width = "100%";
  $("bootMsg").textContent = "準備ができました";

  boot = call(() => api.bootstrap());
  if (!boot) return;
  plan = { ...boot.default_plan };

  fillSelect($<HTMLSelectElement>("formation"), boot.formations, boot.formations[0] ?? "4-4-2");
  renderPlanRows();
  renderPlanPresets();
  $<HTMLButtonElement>("loadBtn").disabled = !hasSave();
  /* 🔑 建物の絵と、押せる場所の位置を**同じ1か所（`city.ts` の SPOTS）から出す**。
        CSS に座標を書き写すと、絵を動かしたときに押せる場所だけ取り残される */
  City.draw($<HTMLCanvasElement>("cityCanvas"));
  for (const [key, at] of Object.entries(City.SPOTS)) {
    const spot = $(`go${key[0]!.toUpperCase()}${key.slice(1)}`);
    spot.style.left = `${at.left}%`;
    spot.style.top = `${at.top}%`;
  }
  renderShop();
  showScreen("boot");

  /* ---- タイトル → チーム作成 ---- */
  $("titleNew").addEventListener("click", () => { showScreen("setup"); });

  /* ---- 街から施設へ、施設から街へ ----
     🔑 行き先は押されたボタンの `data-go`、戻りは `data-back` が持つ。
        片方ずつ `addEventListener` を書くと、施設が増えるたびに書き忘れが出る */
  $("city").addEventListener("click", (ev) => {
    const go = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-go]")?.dataset.go;
    if (go) showScreen(go);
  });
  for (const b of document.querySelectorAll<HTMLElement>("[data-back]")) {
    b.addEventListener("click", () => { showScreen("city"); });
  }

  /* ---- チーム作成 ---- */
  $("startBtn").addEventListener("click", () => {
    const out = call(() => api.newGame($<HTMLInputElement>("teamName").value,
                                       Number($<HTMLInputElement>("seed").value),
                                       $<HTMLSelectElement>("formation").value, plan));
    if (!out) return;
    view = out;
    policyDraft = view.policy.map((r) => ({ ...r }));
    renderHome();
    saveGame(true);
    showScreen("city");
  });

  $("loadBtn").addEventListener("click", () => {
    let raw: unknown;
    try {
      raw = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null");
    } catch {
      showError("保存されたデータが壊れています。最初から始めてください。");
      return;
    }
    const out = call(() => api.loadSave(raw));
    if (!out) {
      /* 🔴 「読めません」だけでは、何をすればよいか分からない。
         形式が変わった場合は作り直すしかないので、そこまで言う */
      $("errorMsg").textContent += "  ゲームの形式が新しくなった場合は、"
        + "「開幕する」で作り直してください（前の進みは戻せません）。";
      return;
    }
    view = out;
    policyDraft = view.policy.map((r) => ({ ...r }));
    renderHome();
    showScreen("city");
  });

  /* ---- タブ ---- */
  $("tabs").addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".tab");
    if (!btn) return;
    for (const t of document.querySelectorAll(".tab")) t.classList.remove("is-on");
    btn.classList.add("is-on");
    for (const p of document.querySelectorAll<HTMLElement>(".tab-page")) {
      p.classList.toggle("is-on", p.dataset.page === btn.dataset.tab);
    }
  });

  /* ---- ホーム ---- */
  $("playBtn").addEventListener("click", startMatch);
  $("saveBtn").addEventListener("click", () => saveGame(false));
  $("exportBtn").addEventListener("click", () => {
    const data = call(() => api.saveDict());
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dot-soccer-${V().team}-S${V().season}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("resetBtn").addEventListener("click", () => {
    /* 🔴 取り返しがつかないので1段挟む。confirm はブラウザを止めるので使わない */
    if ($("resetBtn").dataset.armed === "1") {
      localStorage.removeItem(SAVE_KEY);
      location.reload();
      return;
    }
    $("resetBtn").dataset.armed = "1";
    $("resetBtn").textContent = "本当に消す（もう一度押す）";
    $("saveMsg").textContent = "進みが全部消えます。やめるなら他の画面へ移ってください。";
  });

  /* ---- 特訓 ---- */
  $("swapBtn").addEventListener("click", () => {
    swapMode = !swapMode;
    swapFrom = null;
    $("swapBtn").textContent = swapMode ? "入れ替えをやめる" : "先発と控えを入れ替える";
    $("swapMsg").textContent = swapMode ? "外す先発を選んでください。" : "";
    /* 入れ替え中は特訓の画面を閉じる（同じ一覧を2つの意味で使うため） */
    if (swapMode) {
      $("trainPanel").hidden = true;
      selectedPlayer = null;
    }
    renderSquad();
  });
  $("trainBtn").addEventListener("click", doTrain);
  $("trainCancel").addEventListener("click", () => {
    selectedPlayer = null;
    selectedCards = [];
    $("trainPanel").hidden = true;
    renderSquad();
  });

  /* ---- 戦術 ---- */
  $("tLine").addEventListener("input", () => {
    $("tLineVal").textContent = $<HTMLInputElement>("tLine").value;
  });
  $("tWidth").addEventListener("input", () => {
    $("tWidthVal").textContent = $<HTMLInputElement>("tWidth").value;
  });
  $("policyAdd").addEventListener("click", () => {
    policyDraft.push({ condition: B().policy_conditions[0]!, action: B().policy_actions[0]! });
    renderPolicyRows();
  });
  $("tacticsSave").addEventListener("click", saveTactics);
  $("lineupReset").addEventListener("click", () => {
    const out = call(() => api.resetLineup());
    if (!out) return;
    view = out;
    $("lineupMsg").textContent = "フォーメーションの形に戻しました。";
    renderBoard();
    saveGame(true);
  });
  /* 🔑 フォーメーションを選び直したら盤も入れ替わる。
        「決める」を押すまで古い形のままだと、何を触っているのか分からない */
  $("tFormation").addEventListener("change", () => {
    const out = call(() => api.setTactics(Number($<HTMLInputElement>("tLine").value),
                                          Number($<HTMLInputElement>("tWidth").value),
                                          $<HTMLSelectElement>("tAttitude").value,
                                          $<HTMLSelectElement>("tFormation").value));
    if (!out) return;
    view = out;
    $("lineupMsg").textContent = "";
    renderBoard();
  });

  /* ---- 試合の操作 ---- */
  $("mcPlay").addEventListener("click", () => {
    $("mcPlay").textContent = Pitch.toggle() ? "一時停止" : "再生";
  });
  /* 🔑 ×1 は実時間（90分かかる）。飛ばしたいときのために上も用意する */
  const SPEEDS = [1, 2, 5, 10, 30];
  const speedLabel = (v: number): string => (v === 1 ? "速さ ×1（実時間）" : `速さ ×${v}`);
  let speedAt = 0;
  $("mcSpeed").textContent = speedLabel(SPEEDS[speedAt]!);
  Pitch.setSpeed(SPEEDS[speedAt]!);
  $("mcSpeed").addEventListener("click", () => {
    speedAt = (speedAt + 1) % SPEEDS.length;
    Pitch.setSpeed(SPEEDS[speedAt]!);
    $("mcSpeed").textContent = speedLabel(SPEEDS[speedAt]!);
  });
  $("mcSkip").addEventListener("click", () => {
    /* 🔑 出ている演出を先に畳む。畳まずに飛ばすと、
          結果の上にハーフタイムの幕が残って操作できなくなる */
    skipAll = true;
    Ceremony.cancel();
    Pitch.skipToEnd();
  });

  /* 全画面。🔑 盤の倍率は整数なので、窓にブラウザの枠があると高さが足りず2倍で止まる。
     全画面にすると 1920×1080 がそのまま使えて3倍になる（`pitch.ts` の fit()）。 */
  $("mcFull").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("mcFull");
    if (document.fullscreenElement === null) {
      /* 🔑 失敗を黙らせない。ブラウザや設定によっては断られる */
      document.documentElement.requestFullscreen().catch((e: unknown) => {
        showError(`全画面にできませんでした（${e instanceof Error ? e.message : String(e)}）。`
                  + "  ブラウザの全画面（F11）でも同じ大きさになります。");
      });
    } else {
      void document.exitFullscreen();
    }
    btn.textContent = document.fullscreenElement === null ? "全画面をやめる" : "全画面にする";
  });
  $("matchDone").addEventListener("click", () => {
    Pitch.stop();
    renderHome();
    showScreen("city");
  });

  $("errorClose").addEventListener("click", () => { $("errorBox").hidden = true; });
}

main();
