/* 画面の組み立てと操作。
 *
 * 🔴 ここにもゲームの規則を書かない。判定は必ず Python 側（`web/api.py` → `sim/`）。
 *    ここがやるのは「返ってきた値を並べる」ことと「押されたら渡す」ことだけ。
 */

'use strict';

const SAVE_KEY = 'dot-soccer-save-v1';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let boot = null;        // 変わらない情報（カード一覧・選択肢）
let view = null;        // いまの状態
let plan = {};          // 初期育成の配分
let selectedPlayer = null;
let selectedCards = [];
let matchData = null;
let swapMode = false;      // 先発と控えの入れ替え中か
let swapFrom = null;       // 入れ替える先発の番号
let lastScore = null;      // 得点の演出を出すため、直前のスコアを覚える

/* ------------------------------------------------------------------ 共通 */

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('is-on');
  $(id).classList.add('is-on');
  window.scrollTo(0, 0);
}

function showError(message, title) {
  $('errorTitle').textContent = title || 'うまくいきませんでした';
  $('errorMsg').textContent = message;
  $('errorBox').hidden = false;
}

/** Python を呼ぶ。日本語の理由が返ってきたらそれを出し、それ以外は原因ごと出す。 */
function call(name, ...args) {
  try {
    return Bridge.call(name, ...args);
  } catch (e) {
    if (e instanceof Bridge.GameError) {
      showError(e.message);
    } else {
      /* 🔴 握りつぶさない。**押しても何も起きない画面**が一番たちが悪い */
      console.error('[dot-soccer]', e);
      showError(String(e && e.message ? e.message : e), '想定していない失敗です');
    }
    return null;
  }
}

function minuteText(tick) {
  const m = Math.floor(tick / 60);
  const s = tick % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* -------------------------------------------------------------- セーブ */

function saveGame(quiet) {
  const data = call('save_dict');
  if (!data) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    if (!quiet) $('saveMsg').textContent = '保存しました。';
  } catch (e) {
    /* 🔴 保存できないことを黙らない。閉じたら消えることを伝える */
    $('saveMsg').textContent = '保存できませんでした。この画面を閉じると進みが消えます。';
    console.error('[dot-soccer] 保存', e);
  }
}

function hasSave() {
  try { return localStorage.getItem(SAVE_KEY) !== null; } catch { return false; }
}

/* -------------------------------------------------- チーム作成の初期育成 */

function renderPlanRows() {
  const rows = $('planRows');
  rows.textContent = '';
  for (const [key, card] of Object.entries(boot.cards)) {
    const row = el('div', 'plan-row');
    row.append(el('span', null, card.label));
    const range = el('input');
    range.type = 'range';
    range.min = '0';
    range.max = String(boot.trainings_per_player);
    range.value = String(plan[key] || 0);
    range.addEventListener('input', () => {
      plan[key] = Number(range.value);
      updatePlanTotal();
    });
    const out = el('output', null, String(plan[key] || 0));
    out.dataset.key = key;
    row.append(range, out);
    rows.append(row);
  }
  updatePlanTotal();
}

function updatePlanTotal() {
  const total = Object.values(plan).reduce((a, b) => a + b, 0);
  const target = boot.trainings_per_player;
  $('planUsed').textContent = String(total);
  $('planTotal').textContent = String(target);
  $('planTotalTarget').textContent = String(target);
  for (const out of $('planRows').querySelectorAll('output')) {
    out.textContent = String(plan[out.dataset.key] || 0);
  }
  for (const r of $('planRows').querySelectorAll('input[type="range"]')) {
    const key = r.parentElement.querySelector('output').dataset.key;
    r.value = String(plan[key] || 0);
  }
  /* 🔴 「ちょうど20回」でなければ開幕させない。足りないとAIだけ育った状態で始まる */
  const ok = total === target;
  $('startBtn').disabled = !ok;
  $('planWarn').textContent = ok ? ''
    : (total < target ? `（あと ${target - total} 回）` : `（${total - target} 回 多い）`);
}

function renderPlanPresets() {
  const box = $('planPresets');
  box.textContent = '';
  for (const [name, preset] of Object.entries(boot.preset_plans)) {
    const chip = el('button', 'chip', name);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      plan = { ...preset };
      updatePlanTotal();
    });
    box.append(chip);
  }
}

/* ---------------------------------------------------------------- ホーム */

function renderHome() {
  $('hudTeam').textContent = view.team;
  $('hudRank').textContent = `${view.rank}位`;
  $('hudRound').textContent = view.season_finished
    ? `${view.season}シーズン目 — 全${view.total_rounds}節 終了`
    : `${view.season}シーズン目 第${view.round + 1}節 / ${view.total_rounds}`;

  const fx = $('nextFixture');
  fx.textContent = '';
  if (view.season_finished) {
    fx.append(el('span', null, '全節終了。シーズンを締めます'));
    $('playBtn').textContent = 'シーズンを締める';
  } else if (view.next_fixture) {
    const [home, away] = view.next_fixture;
    fx.append(el('span', null, home), el('span', 'vs', 'vs'), el('span', null, away));
    $('playBtn').textContent = 'キックオフ';
  }

  const stock = $('cardStock');
  stock.textContent = '';
  const keys = Object.keys(view.cards);
  if (keys.length === 0) {
    stock.append(el('p', 'stock-empty', 'まだありません。試合で課題が出るともらえます。'));
  } else {
    for (const key of keys) {
      const s = el('div', 'stock');
      s.append(el('span', null, boot.cards[key].label), el('b', null, `×${view.cards[key]}`));
      stock.append(s);
    }
  }

  renderSquad();
  renderTacticsForm();
  renderStandings();
  renderFixtures();
  renderHistory();
}

/* ---------------------------------------------------------------- 選手 */

function renderSquad() {
  const list = $('squadList');
  list.textContent = '';
  for (const p of view.squad) {
    const btn = el('button', `player${p.starter ? '' : ' is-bench'}`);
    btn.type = 'button';
    if (selectedPlayer === p.index) btn.classList.add('is-on');

    const pos = el('span', 'pos', p.position);
    pos.dataset.pos = p.position;
    const main = el('div', 'player-main');
    main.append(el('div', 'player-name', p.name),
                el('div', 'player-type', `${p.type}${p.starter ? '' : '（控え）'}`));
    const total = Object.values(p.visible).reduce((a, b) => a + b, 0);
    const abil = el('div', 'player-abil');
    abil.append(el('div', null, `合計 ${total}`),
                /* 🔑 生まれ持った性質。特訓では動かないので「この選手はこういう選手」
                   という読み方になる。受け持ちの広さと、どこまで見えているか */
                el('div', 'player-trait', `範囲 ${p.roam_m}m / 視野 ${p.vision_m}m`));

    btn.append(pos, main, abil);
    if (swapMode && swapFrom === p.index) btn.classList.add('is-swap');
    btn.addEventListener('click', () => (swapMode ? pickForSwap(p) : selectPlayer(p.index)));
    list.append(btn);
  }
}

function pickForSwap(p) {
  /* 🔑 2段階にする。1人目に先発、2人目に控えを選ばせる。
     一覧から2人選ぶだけなので、番号を打たせない */
  if (swapFrom === null) {
    if (!p.starter) {
      $('swapMsg').textContent = 'まず外す先発を選んでください。';
      return;
    }
    swapFrom = p.index;
    $('swapMsg').textContent = `${p.name} と入れ替える控えを選んでください。`;
    renderSquad();
    return;
  }
  if (p.starter) {
    $('swapMsg').textContent = '入れる控えを選んでください（やめるならもう一度ボタンを押す）。';
    return;
  }
  const out = call('swap_starter', swapFrom, p.index);
  if (!out) { endSwap(); return; }
  view = out;
  $('swapMsg').textContent = '入れ替えました。';
  endSwap();
  renderHome();
  saveGame(true);
}

function endSwap() {
  swapMode = false;
  swapFrom = null;
  $('swapBtn').textContent = '先発と控えを入れ替える';
  renderSquad();
}

function selectPlayer(index) {
  selectedPlayer = index;
  selectedCards = [];
  const p = view.squad.find((x) => x.index === index);
  $('trainWho').textContent = `${p.name}（${p.type}）`;
  $('trainPanel').hidden = false;
  $('trainResult').hidden = true;
  renderSquad();
  renderTrainCards();
}

function renderTrainCards() {
  const box = $('trainCards');
  box.textContent = '';
  const owned = view.cards;
  const keys = Object.keys(owned);
  if (keys.length === 0) {
    box.append(el('p', 'note', 'カードがありません。試合をすると課題からもらえます。'));
  }
  for (const key of keys) {
    const card = boot.cards[key];
    const picked = selectedCards.filter((k) => k === key).length;
    const chip = el('button', `chip${picked ? ' is-on' : ''}`,
                    `${card.label} ×${owned[key]}${picked ? `（選択${picked}）` : ''}`);
    chip.type = 'button';
    chip.addEventListener('click', () => toggleCard(key));
    box.append(chip);
  }
  const hint = $('trainHint');
  if (selectedCards.length === 2) {
    hint.textContent = '2枚＝スペシャル。両方の効果が1.5倍になります。';
  } else if (selectedCards.length === 1) {
    hint.textContent = 'もう1枚選ぶとスペシャルになります（相反する組は選べません）。';
  } else {
    hint.textContent = 'カードを1枚か2枚選んでください。';
  }
  $('trainBtn').disabled = selectedCards.length === 0;
}

function toggleCard(key) {
  const at = selectedCards.indexOf(key);
  const owned = view.cards[key] || 0;
  if (at >= 0) {
    selectedCards.splice(at, 1);
  } else if (selectedCards.length < 2) {
    if (selectedCards.filter((k) => k === key).length >= owned) {
      showError(`「${boot.cards[key].label}」の所持が足りません`);
      return;
    }
    /* 🔴 相反する組はここで止める。Python 側でも弾かれるが、
       押してから日本語で断るより、押す前に分かるほうがよい */
    const pair = [...selectedCards, key].sort();
    const forbidden = boot.forbidden_pairs.some(
      (f) => f.length === 2 && f[0] === pair[0] && f[1] === pair[1]);
    if (forbidden) {
      showError(`「${boot.cards[pair[0]].label}」と「${boot.cards[pair[1]].label}」は`
                + '同時に使えません（効果が打ち消し合います）');
      return;
    }
    selectedCards.push(key);
  }
  renderTrainCards();
}

function doTrain() {
  const out = call('train', selectedPlayer, selectedCards);
  if (!out) return;
  view = out.view;
  const r = out.result;
  const box = $('trainResult');
  box.textContent = '';
  box.hidden = false;
  box.append(el('div', null, `${out.label} — ${r.player}`));

  const ups = [];
  for (const [k, after] of Object.entries(r.visible)) {
    const before = r.visible_before[k];
    if (after !== before) ups.push(`${k} ${before}→${after}`);
  }
  for (const [k, after] of Object.entries(r.hidden)) {
    const before = r.hidden_before[k];
    if (after !== before) ups.push(`${k} ${before}→${after}`);
  }
  box.append(el('div', 'up', ups.join(' / ')));
  box.append(el('div', r.before === r.after ? '' : 'changed',
                r.before === r.after
                  ? `タイプ: ${r.after}（変化なし）`
                  : `★ タイプが変わった: ${r.before} → ${r.after}`));

  selectedCards = [];
  renderHome();
  renderTrainCards();
  saveGame(true);
}

/* ---------------------------------------------------------------- 戦術 */

const MANAGER_LABELS = {
  style: ['守備的', '攻撃的'],
  rigidity: ['弾力的', '徹底的'],
  substitution: ['消極的', '積極的'],
  selection: ['安定感', '期待感'],
};

function renderTacticsForm() {
  fillSelect($('tFormation'), boot.formations, view.tactics.formation);
  fillSelect($('tAttitude'), boot.attitudes, view.tactics.attitude);
  $('tLine').value = String(view.tactics.line_height);
  $('tWidth').value = String(view.tactics.zone_width);
  $('tLineVal').textContent = String(view.tactics.line_height);
  $('tWidthVal').textContent = String(view.tactics.zone_width);

  const rows = $('managerRows');
  rows.textContent = '';
  for (const [key, [left, right]] of Object.entries(MANAGER_LABELS)) {
    const f = el('div', 'field');
    const label = el('label', null, `${left} ↔ ${right}`);
    label.htmlFor = `mg-${key}`;
    const range = el('input');
    range.type = 'range';
    range.id = `mg-${key}`;
    range.min = '-2';
    range.max = '2';
    range.value = String(view.manager[key]);
    range.dataset.key = key;
    f.append(label, range);
    rows.append(f);
  }

  renderPolicyRows();
  $('policyMax').textContent = String(boot.policy_max_rules);
}

function fillSelect(node, options, current) {
  node.textContent = '';
  for (const o of options) {
    const opt = el('option', null, o);
    opt.value = o;
    if (o === current) opt.selected = true;
    node.append(opt);
  }
}

let policyDraft = [];

function renderPolicyRows() {
  const rows = $('policyRows');
  rows.textContent = '';
  policyDraft.forEach((rule, i) => {
    const row = el('div', 'field-row');
    const c = el('div', 'field');
    const cs = el('select');
    fillSelect(cs, boot.policy_conditions, rule.condition);
    cs.addEventListener('change', () => { policyDraft[i].condition = cs.value; });
    c.append(el('label', null, `条件 ${i + 1}`), cs);

    const a = el('div', 'field');
    const as = el('select');
    fillSelect(as, boot.policy_actions, rule.action);
    as.addEventListener('change', () => { policyDraft[i].action = as.value; });
    a.append(el('label', null, '行動'), as);

    const del = el('button', 'btn', '消す');
    del.type = 'button';
    del.addEventListener('click', () => {
      policyDraft.splice(i, 1);
      renderPolicyRows();
    });

    row.append(c, a, del);
    rows.append(row);
  });
  $('policyAdd').disabled = policyDraft.length >= boot.policy_max_rules;
}

function saveTactics() {
  let out = call('set_tactics', Number($('tLine').value), Number($('tWidth').value),
                 $('tAttitude').value, $('tFormation').value);
  if (!out) return;
  const m = {};
  for (const r of $('managerRows').querySelectorAll('input[type="range"]')) {
    m[r.dataset.key] = Number(r.value);
  }
  out = call('set_manager', m.style, m.rigidity, m.substitution, m.selection);
  if (!out) return;
  out = call('set_policy', policyDraft);
  if (!out) return;
  view = out;
  $('tacticsMsg').textContent = '決めました。';
  renderHome();
  saveGame(true);
}

/* ------------------------------------------------------------ 順位・日程 */

function renderStandings() {
  const box = $('standings');
  box.textContent = '';
  const table = el('table');
  const head = el('tr');
  for (const h of ['順', 'チーム', '試', '勝', '分', '敗', '得', '失', '差', '点']) {
    head.append(el('th', h === 'チーム' ? 'name' : null, h));
  }
  /* 🔑 `append()` は何も返さない。戻り値を辿ると undefined になる（実際に踏んだ） */
  const thead = el('thead');
  thead.append(head);
  table.append(thead);
  const body = el('tbody');
  for (const r of view.standings) {
    const tr = el('tr');
    if (r.team === view.team) tr.classList.add('is-me');
    tr.append(el('td', null, String(r.rank)), el('td', 'name', r.team),
              el('td', null, String(r.played)), el('td', null, String(r.w)),
              el('td', null, String(r.d)), el('td', null, String(r.l)),
              el('td', null, String(r.gf)), el('td', null, String(r.ga)),
              el('td', null, (r.gd > 0 ? '+' : '') + r.gd), el('td', null, String(r.points)));
    body.append(tr);
  }
  table.append(body);
  box.append(table);
}

function renderFixtures() {
  const box = $('fixtures');
  box.textContent = '';
  if (view.remaining.length === 0) {
    box.append(el('p', 'note', '残りの試合はありません。'));
    return;
  }
  const table = el('table');
  const body = el('tbody');
  view.remaining.forEach((round, i) => {
    const mine = round.find((f) => f.includes(view.team));
    const tr = el('tr');
    if (i === 0) tr.classList.add('is-me');
    tr.append(el('td', null, `第${view.round + i + 1}節`),
              el('td', 'name', mine ? `${mine[0]} vs ${mine[1]}` : '—'));
    body.append(tr);
  });
  table.append(body);
  box.append(table);
}

function renderHistory() {
  const panel = $('historyPanel');
  if (!view.history.length) { panel.hidden = true; return; }
  panel.hidden = false;
  const box = $('history');
  box.textContent = '';
  const table = el('table');
  const body = el('tbody');
  for (const h of view.history) {
    const tr = el('tr');
    tr.append(el('td', null, `${h.season}シーズン目`), el('td', 'name', `${h.rank}位`));
    body.append(tr);
  }
  table.append(body);
  box.append(table);
}

/* ---------------------------------------------------------------- 試合 */

function startMatch() {
  if (view.season_finished) {
    const out = call('finish_season');
    if (!out) return;
    view = out.view;
    renderHome();
    saveGame(true);
    showError(`${out.summary.season}シーズン目は ${out.summary.rank}位でした。`
              + `${view.season}シーズン目が始まります。`, 'シーズン終了');
    return;
  }

  const out = call('play_next');
  if (!out) return;
  matchData = out;
  view = out.view;
  saveGame(true);

  /* 🔑 ピッチの色は「ホーム＝黄／アウェー＝青」で固定する（盤面が読みやすい）。
     自分のチームがどちらかは**名前の前の★**で示す。色まで入れ替えると、
     試合ごとに自分の色が変わって盤面が読めなくなる。 */
  $('sbHome').textContent = (out.my_index === 0 ? '★ ' : '') + out.teams[0];
  $('sbAway').textContent = out.teams[1] + (out.my_index === 1 ? ' ★' : '');
  $('sbScore').textContent = '0 - 0';
  $('sbClock').textContent = '0:00';
  $('ticker').textContent = 'キックオフ';
  $('matchResult').hidden = true;
  $('mcPlay').textContent = '一時停止';
  showScreen('match');

  lastScore = null;
  Pitch.load(out.replay, out.events, out.teams[0], {
    onUpdate: (s) => {
      /* 🔴 スコアが動いた瞬間に知らせる。数字が増えるだけだと見逃す */
      const now = `${s.home}-${s.away}`;
      if (lastScore !== null && lastScore !== now) showGoal(s.event);
      lastScore = now;
      $('sbScore').textContent = `${s.home} - ${s.away}`;
      $('sbClock').textContent = minuteText(s.tick);
      const t = $('ticker');
      t.textContent = '';
      if (s.event) {
        t.append(el('span', 't-time', s.event.time));
        const label = `${s.event.type}${s.event.player ? ` — ${s.event.player}` : ''}`
                    + `${s.event.detail ? ` ${s.event.detail}` : ''}`;
        t.append(el('span', s.event.type === 'ゴール' ? 't-goal' : null, label));
      } else {
        t.append(el('span', null, 'キックオフ'));
      }
    },
    onFinish: showMatchResult,
  });
}

let goalTimer = 0;

function showGoal(ev) {
  const box = $('goalFlash');
  $('goalWho').textContent = ev && ev.player ? `${ev.player}（${ev.team}）` : '';
  box.hidden = false;
  clearTimeout(goalTimer);
  goalTimer = setTimeout(() => { box.hidden = true; }, 2600);
}

function showMatchResult() {
  if (!matchData || !$('matchResult').hidden) return;
  const out = matchData;
  const mine = out.my_index;
  const theirs = 1 - mine;

  const box = $('statTable');
  box.textContent = '';
  const table = el('table');
  const head = el('tr');
  head.append(el('th', 'name', ''), el('th', null, out.teams[0]), el('th', null, out.teams[1]));
  const thead = el('thead');
  thead.append(head);
  table.append(thead);
  const body = el('tbody');
  const ROWS = [
    ['シュート', 'shots'], ['得点', 'goals'], ['パス', 'passes'],
    ['パス成功率', 'pass_success_pct'], ['ボール奪取', 'tackles_won'],
    ['裏を取られた', 'beaten_behind'], ['走行距離(km)', 'distance_km'],
    ['支配率', 'possession_pct'], ['息切れ人数', 'stamina_low_players'],
  ];
  for (const [label, key] of ROWS) {
    const tr = el('tr');
    tr.append(el('td', 'name', label),
              el('td', null, String(out.stats[0][key])),
              el('td', null, String(out.stats[1][key])));
    body.append(tr);
  }
  table.append(body);
  box.append(table);

  const aw = $('awarded');
  aw.textContent = '';
  if (out.awarded.length === 0) {
    aw.append(el('p', 'note', '今回は課題が出ませんでした。'));
  } else {
    for (const a of out.awarded) {
      const chip = el('div', 'stock award');
      chip.append(el('div', 'award-name', a.label),
                  el('div', 'award-why', a.issue));
      aw.append(chip);
    }
  }

  const ot = $('others');
  ot.textContent = '';
  const t2 = el('table');
  const b2 = el('tbody');
  for (const o of out.others) {
    const tr = el('tr');
    tr.append(el('td', 'name', `${o.home} ${o.home_goals} - ${o.away_goals} ${o.away}`));
    b2.append(tr);
  }
  t2.append(b2);
  ot.append(t2);

  void theirs;                 // 相手側の見せ方は次のループで（いまは両チーム並べている）
  $('matchResult').hidden = false;
  $('matchResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ------------------------------------------------------------ 立ち上げ */

async function main() {
  Pitch.attach($('pitch'));

  try {
    await Bridge.boot((pct, msg) => {
      $('bootFill').style.width = `${pct}%`;
      $('bootMsg').textContent = msg;
    });
  } catch (e) {
    console.error('[dot-soccer] 起動', e);
    $('bootMsg').textContent = '読み込めませんでした。通信を確かめて、再読み込みしてください。';
    showError(String(e && e.message ? e.message : e), '起動できませんでした');
    return;
  }

  boot = call('bootstrap');
  if (!boot) return;
  plan = { ...boot.default_plan };

  fillSelect($('formation'), boot.formations, boot.formations[0]);
  renderPlanRows();
  renderPlanPresets();
  $('loadBtn').disabled = !hasSave();
  showScreen('setup');

  /* ---- チーム作成 ---- */
  $('startBtn').addEventListener('click', () => {
    const out = call('new_game', $('teamName').value, Number($('seed').value),
                     $('formation').value, plan);
    if (!out) return;
    view = out;
    policyDraft = view.policy.map((r) => ({ ...r }));
    renderHome();
    saveGame(true);
    showScreen('home');
  });

  $('loadBtn').addEventListener('click', () => {
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem(SAVE_KEY));
    } catch (e) {
      showError('保存されたデータが壊れています。最初から始めてください。');
      return;
    }
    const out = call('load_save', raw);
    if (!out) {
      /* 🔴 「読めません」だけでは、何をすればよいか分からない。
         形式が変わった場合は作り直すしかないので、そこまで言う */
      $('errorMsg').textContent += '  ゲームの形式が新しくなった場合は、'
        + '「開幕する」で作り直してください（前の進みは戻せません）。';
      return;
    }
    view = out;
    policyDraft = view.policy.map((r) => ({ ...r }));
    renderHome();
    showScreen('home');
  });

  /* ---- タブ ---- */
  $('tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('is-on');
    btn.classList.add('is-on');
    for (const p of document.querySelectorAll('.tab-page')) {
      p.classList.toggle('is-on', p.dataset.page === btn.dataset.tab);
    }
  });

  /* ---- ホーム ---- */
  $('playBtn').addEventListener('click', startMatch);
  $('saveBtn').addEventListener('click', () => saveGame(false));
  $('exportBtn').addEventListener('click', () => {
    const data = call('save_dict');
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dot-soccer-${view.team}-S${view.season}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('resetBtn').addEventListener('click', () => {
    /* 🔴 取り返しがつかないので1段挟む。confirm はブラウザを止めるので使わない */
    if ($('resetBtn').dataset.armed === '1') {
      localStorage.removeItem(SAVE_KEY);
      location.reload();
      return;
    }
    $('resetBtn').dataset.armed = '1';
    $('resetBtn').textContent = '本当に消す（もう一度押す）';
    $('saveMsg').textContent = '進みが全部消えます。やめるなら他の画面へ移ってください。';
  });

  /* ---- 特訓 ---- */
  $('swapBtn').addEventListener('click', () => {
    swapMode = !swapMode;
    swapFrom = null;
    $('swapBtn').textContent = swapMode ? '入れ替えをやめる' : '先発と控えを入れ替える';
    $('swapMsg').textContent = swapMode ? '外す先発を選んでください。' : '';
    /* 入れ替え中は特訓の画面を閉じる（同じ一覧を2つの意味で使うため） */
    if (swapMode) { $('trainPanel').hidden = true; selectedPlayer = null; }
    renderSquad();
  });
  $('trainBtn').addEventListener('click', doTrain);
  $('trainCancel').addEventListener('click', () => {
    selectedPlayer = null;
    selectedCards = [];
    $('trainPanel').hidden = true;
    renderSquad();
  });

  /* ---- 戦術 ---- */
  $('tLine').addEventListener('input', () => { $('tLineVal').textContent = $('tLine').value; });
  $('tWidth').addEventListener('input', () => { $('tWidthVal').textContent = $('tWidth').value; });
  $('policyAdd').addEventListener('click', () => {
    policyDraft.push({ condition: boot.policy_conditions[0], action: boot.policy_actions[0] });
    renderPolicyRows();
  });
  $('tacticsSave').addEventListener('click', saveTactics);

  /* ---- 試合の操作 ---- */
  $('mcPlay').addEventListener('click', () => {
    $('mcPlay').textContent = Pitch.toggle() ? '一時停止' : '再生';
  });
  /* 🔑 ×1 は実時間（90分かかる）。飛ばしたいときのために上も用意する */
  const SPEEDS = [1, 2, 5, 10, 30];
  const speedLabel = (v) => (v === 1 ? '速さ ×1（実時間）' : `速さ ×${v}`);
  let speedAt = 0;
  $('mcSpeed').textContent = speedLabel(SPEEDS[speedAt]);
  Pitch.setSpeed(SPEEDS[speedAt]);
  $('mcSpeed').addEventListener('click', () => {
    speedAt = (speedAt + 1) % SPEEDS.length;
    Pitch.setSpeed(SPEEDS[speedAt]);
    $('mcSpeed').textContent = speedLabel(SPEEDS[speedAt]);
  });
  $('mcSkip').addEventListener('click', () => Pitch.skipToEnd());
  $('matchDone').addEventListener('click', () => {
    Pitch.stop();
    renderHome();
    showScreen('home');
  });

  $('errorClose').addEventListener('click', () => { $('errorBox').hidden = true; });
}

main();
