/**
 * 新しい試合エンジン（src/sim/match/・D-42）を目で確かめるための再生画面を書き出す。
 *
 * 使い方:
 *     npm run viewer                 # 10分・種1 → out/match_viewer.html
 *     npm run viewer -- 30 4         # 30分・種4
 *
 * 🔑 開発用の道具で、ゲームの画面ではない（ゲームの3D画面につなぐのは切り替えのとき）。
 *    1枚の HTML に記録を埋め込むので、ファイルを開くだけで見られる（サーバー不要）。
 * 🔑 記録は 0.1秒ごと・位置は 10cm 単位。10分で約1.5MB。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MatchSim, standardSetup } from "../src/sim/match/match.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "out", "match_viewer.html");

/** 役割の1文字（画面に出す） */
const ROLE_MARK: Record<string, string> = {
  BLOCK: "", PRESS: "寄", CONTAIN: "構", COVER: "埋", SHIELD: "壁", OUTLET: "受", GK: "", TAKER: "蹴", RUNNER: "走", BOX: "箱",
};

interface ViewerEvent {
  tick: number;
  team: 0 | 1 | null;
  text: string;
}

const RESTART_NAME: Record<string, string> = {
  KICKOFF: "キックオフ", THROW_IN: "スローイン", GOAL_KICK: "ゴールキック", CORNER: "コーナーキック",
  FREE_KICK: "フリーキック",
};
const SHOT_NAME: Record<string, string> = {
  GOAL: "ゴール！", SAVED: "GKがセーブ", BLOCKED: "ブロック", OFF_TARGET: "枠外",
};

function main(argv: string[]): number {
  const minutes = Number(argv[0] ?? 10);
  const seed = Number(argv[1] ?? 1);
  const sim = new MatchSim({ ...standardSetup(), seed });
  const ticks = Math.round(minutes * 600);

  const frames: number[] = [];        // [ボールx, ボールy, ボールの高さ, 持っている人, 22人の x, y …] を 10cm 単位で
  const roles: string[] = [];         // コマごとに 22文字（役割の1文字。無ければ "・"）
  const events: ViewerEvent[] = [];
  const t0 = performance.now();
  let passes = 0;
  let shots = 0;
  let restart: string | null = null;

  for (let i = 0; i < ticks; i++) {
    sim.step();
    frames.push(Math.round(sim.ball.x * 10), Math.round(sim.ball.y * 10), Math.round(sim.ball.z * 10),
                sim.holder?.id ?? -1);
    let r = "";
    for (const a of sim.agents) {
      frames.push(Math.round(a.body.x * 10), Math.round(a.body.y * 10));
      const role = sim.plans[a.team].orders.get(a.id)?.role ?? "";
      r += ROLE_MARK[role] || "・";
    }
    roles.push(r);
    // 出来事
    while (shots < sim.shots.length) {
      const s = sim.shots[shots++]!;
      events.push({ tick: i, team: s.team,
                    text: `${s.header ? "ヘディング" : "シュート"} ${s.distance.toFixed(0)}m（見込み ${(s.chance * 100).toFixed(0)}%）→ ${SHOT_NAME[s.result]}` });
    }
    while (passes < sim.passes.length) {
      const p = sim.passes[passes++]!;
      if (p.result === "OFFSIDE") events.push({ tick: i, team: p.team, text: "オフサイド" });
      // クロス: 浮かせたパスが相手のペナルティエリアに落ちた
      const depth = p.team === 0 ? 105 - p.toX : p.toX;
      if (p.lofted && depth <= 16.5 && Math.abs(p.toY - 34) <= 20.16) {
        events.push({ tick: i, team: p.team, text: `クロス → ${p.result === "COMPLETED" ? "味方が合わせた" : "相手が触った"}` });
      }
    }
    const now = sim.restart?.kind ?? null;
    if (now !== null && now !== restart) {
      events.push({ tick: i, team: sim.restart!.team, text: RESTART_NAME[now] ?? now });
    }
    restart = now;
  }

  const teams = sim.agents.map((a) => a.team);
  const gk = sim.agents.map((a) => (a.role === "GK" ? 1 : 0));
  const data = {
    minutes, seed, ticks, teams, gk, frames, roles, events,
    score: sim.score,
    summary: {
      passes: sim.passes.length,
      completed: sim.passes.filter((p) => p.result === "COMPLETED").length,
      shots: [0, 1].map((t) => sim.shots.filter((s) => s.team === t).length),
    },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html(JSON.stringify(data)), "utf8");
  console.log(`${minutes}分（種 ${seed}）を ${((performance.now() - t0) / 1000).toFixed(1)}秒で計算 → ${OUT}`);
  console.log(`スコア ${sim.score.join("-")}・パス ${data.summary.passes}本（成功 ${data.summary.completed}）・シュート ${data.summary.shots.join("-")}`);
  return 0;
}

function html(json: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>新エンジン再生</title>
<style>
  :root { --bg:#f4f1ea; --ink:#222; --sub:#666; --line:#fff; --grass:#3f8f4f; --grass2:#3a8749;
          --a:#2563eb; --b:#dc2626; --panel:#fff; --border:#ddd; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#16181d; --ink:#eee; --sub:#aaa; --panel:#22252c; --border:#3a3d45; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }
  main { max-width:1200px; margin:0 auto; padding:16px; display:grid; gap:12px;
         grid-template-columns: minmax(0,1fr) 300px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  h1 { font-size:16px; margin:0 0 4px; }
  .board { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px; }
  canvas { width:100%; height:auto; display:block; border-radius:4px; }
  .bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
  .bar input[type=range] { flex:1; min-width:160px; }
  button, select { font:inherit; padding:4px 10px; border-radius:6px; border:1px solid var(--border);
                   background:var(--panel); color:var(--ink); cursor:pointer; }
  .score { font-size:22px; font-weight:700; font-variant-numeric: tabular-nums; }
  .clock { font-variant-numeric: tabular-nums; color:var(--sub); }
  .a { color:var(--a); } .b { color:var(--b); }
  ul { list-style:none; margin:0; padding:0; max-height:520px; overflow:auto; }
  li { padding:4px 6px; border-bottom:1px solid var(--border); cursor:pointer; }
  li:hover { background: rgba(127,127,127,.12); }
  li .t { color:var(--sub); font-variant-numeric: tabular-nums; margin-right:6px; }
  .legend { color:var(--sub); font-size:12px; margin-top:8px; }
</style>
</head>
<body>
<main>
  <section class="board">
    <h1>新しい試合エンジン（D-42）の再生</h1>
    <div class="bar"><span class="score"><span class="a">青</span> <span id="score">0 - 0</span> <span class="b">赤</span></span>
      <span class="clock" id="clock">00:00.0</span><span class="clock" id="meta"></span></div>
    <canvas id="pitch" width="1050" height="680"></canvas>
    <div class="bar">
      <button id="play">▶ 再生</button>
      <select id="speed"><option value="1">×1</option><option value="2">×2</option><option value="4" selected>×4</option><option value="8">×8</option><option value="16">×16</option></select>
      <input id="seek" type="range" min="0" value="0">
    </div>
    <div class="legend">青は右へ、赤は左へ攻める。輪の付いた選手がボールを持っている。
      文字は役割（寄＝寄せる・構＝寄せずにコースを切る・埋＝後ろを埋める・壁＝シュートコースを塞ぐ・受＝パスの出し先候補・走＝裏へ走り込む・箱＝ゴール前へ入る・蹴＝再開で蹴る）。
      点線は守っている側のオフサイドライン（後ろから2人目）。浮いたボールは影と高さ（m）で表す。</div>
  </section>
  <section class="board">
    <h1>出来事</h1>
    <div class="clock" id="summary"></div>
    <ul id="events"></ul>
  </section>
</main>
<script>
const D = ${json};
const N = D.teams.length, W = 4 + N * 2;
const cv = document.getElementById("pitch"), g = cv.getContext("2d");
const S = 10; // 1m = 10px
let tick = 0, pos = 0, playing = false, last = 0;
const seek = document.getElementById("seek");
seek.max = D.ticks - 1;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

document.getElementById("meta").textContent = "  " + D.minutes + "分・種 " + D.seed;
document.getElementById("summary").textContent =
  "パス " + D.summary.passes + "本（成功 " + D.summary.completed + "）・シュート 青 " + D.summary.shots[0] + " / 赤 " + D.summary.shots[1];
const ul = document.getElementById("events");
for (const e of D.events) {
  const li = document.createElement("li");
  const t = document.createElement("span"); t.className = "t"; t.textContent = clock(e.tick);
  const s = document.createElement("span"); s.className = e.team === 0 ? "a" : e.team === 1 ? "b" : "";
  s.textContent = (e.team === 0 ? "青 " : e.team === 1 ? "赤 " : "") + e.text;
  li.append(t, s);
  li.onclick = () => { tick = pos = Math.max(0, e.tick - 30); draw(); };
  ul.append(li);
}

function clock(k) {
  const s = k / 10, m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + (s - m * 60).toFixed(1).padStart(4, "0");
}
function at(k, j) { return D.frames[k * W + j] / 10; }

function pitch() {
  const L = 105 * S, H = 68 * S;
  for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? css("--grass") : css("--grass2"); g.fillRect(i * L / 10, 0, L / 10, H); }
  g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 2;
  g.strokeRect(1, 1, L - 2, H - 2);
  g.beginPath(); g.moveTo(L / 2, 0); g.lineTo(L / 2, H); g.stroke();
  g.beginPath(); g.arc(L / 2, H / 2, 9.15 * S, 0, Math.PI * 2); g.stroke();
  for (const x0 of [0, 105]) {
    const d = x0 === 0 ? 1 : -1;
    g.strokeRect(x0 * S + (d < 0 ? -16.5 * S : 0), (34 - 20.16) * S, 16.5 * S, 40.32 * S);
    g.strokeRect(x0 * S + (d < 0 ? -5.5 * S : 0), (34 - 9.16) * S, 5.5 * S, 18.32 * S);
    g.fillStyle = "rgba(255,255,255,.9)";
    g.fillRect(x0 * S + (d < 0 ? 0 : -6), (34 - 3.66) * S, 6, 7.32 * S);
  }
}

function draw() {
  tick = Math.max(0, Math.min(D.ticks - 1, tick));
  seek.value = tick;
  document.getElementById("clock").textContent = clock(tick);
  let sc = [0, 0];
  for (const e of D.events) if (e.tick <= tick && e.text.endsWith("ゴール！")) sc[e.team]++;
  document.getElementById("score").textContent = sc[0] + " - " + sc[1];
  pitch();
  const holder = D.frames[tick * W + 3];
  const ballX = at(tick, 0);
  // 守っている側のオフサイドライン（後ろから2人目）。持っているチームがいなければ出さない
  if (holder >= 0) {
    const atk = D.teams[holder], dir = atk === 0 ? 1 : -1, goal = atk === 0 ? 105 : 0;
    const depth = [];
    for (let i = 0; i < N; i++) if (D.teams[i] !== atk) depth.push(Math.abs(goal - at(tick, 4 + i * 2)));
    depth.sort((a, b) => a - b);
    const line = goal - dir * Math.min(depth[1], Math.abs(goal - ballX), 52.5);
    g.setLineDash([8, 8]); g.strokeStyle = "rgba(255,255,0,.8)";
    g.beginPath(); g.moveTo(line * S, 0); g.lineTo(line * S, 68 * S); g.stroke(); g.setLineDash([]);
  }
  const roles = D.roles[tick];
  for (let i = 0; i < N; i++) {
    const x = at(tick, 4 + i * 2) * S, y = at(tick, 5 + i * 2) * S;
    g.fillStyle = D.teams[i] === 0 ? css("--a") : css("--b");
    g.beginPath(); g.arc(x, y, D.gk[i] ? 11 : 9, 0, Math.PI * 2); g.fill();
    if (D.gk[i]) { g.strokeStyle = "#ffeb3b"; g.lineWidth = 3; g.stroke(); }
    if (i === holder) { g.strokeStyle = "#fff"; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 15, 0, Math.PI * 2); g.stroke(); }
    const m = roles[i];
    if (m !== "・") { g.fillStyle = "#fff"; g.font = "bold 13px system-ui"; g.textAlign = "center"; g.fillText(m, x, y - 14); }
  }
  // ボール: 浮いていれば地面に影を落とし、高いほど大きく描いて高さを添える
  const bz = at(tick, 2), bx = ballX * S, by = at(tick, 1) * S;
  if (bz > 0.05) {
    g.fillStyle = "rgba(0,0,0,.35)"; g.beginPath(); g.ellipse(bx, by, 6, 3, 0, 0, Math.PI * 2); g.fill();
  }
  const r = 5 + Math.min(bz, 10) * 0.8, lift = bz * 3;
  g.fillStyle = "#fff"; g.strokeStyle = "#111"; g.lineWidth = 2;
  g.beginPath(); g.arc(bx, by - lift, r, 0, Math.PI * 2); g.fill(); g.stroke();
  if (bz > 0.3) { g.fillStyle = "#fff"; g.font = "12px system-ui"; g.textAlign = "left"; g.fillText(bz.toFixed(1) + "m", bx + r + 3, by - lift); }
}

function loop(ts) {
  if (playing) {
    const sp = Number(document.getElementById("speed").value);
    if (last) pos += (ts - last) / 100 * sp;   // 0.1秒＝1コマ。進んだ量は小数のまま持つ
    last = ts;
    if (pos >= D.ticks - 1) { playing = false; document.getElementById("play").textContent = "▶ 再生"; }
    tick = Math.floor(pos);
    draw();
  }
  requestAnimationFrame(loop);
}
document.getElementById("play").onclick = () => {
  playing = !playing; last = 0;
  document.getElementById("play").textContent = playing ? "⏸ 一時停止" : "▶ 再生";
};
seek.oninput = () => { tick = pos = Number(seek.value); draw(); };
// URL の末尾 #t=秒 で、その時刻から開く（例: #t=551）
const m = location.hash.match(/t=([0-9.]+)/);
if (m) tick = pos = Math.round(Number(m[1]) * 10);
draw();
requestAnimationFrame(loop);
</script>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
