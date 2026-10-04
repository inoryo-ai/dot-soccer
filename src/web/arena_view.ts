/**
 * 練習場 1対1 を見る検証ページ（`web/arena.html`・D-48）。
 *
 * 🔑 **試合の画面（`match3d.ts`）をそのまま使う。** 練習場の結果は試合と同じ形のリプレイ（`area` つき）なので、
 *    描き方を別に持たない（オーナー指示「現状のビジュアルシステムを踏襲しつつ」）。
 * 🔴 ここもゲームの規則を1行も持たない。`src/sim/arena.ts` が出した結果を並べるだけ。
 */

import { playArena } from "../sim/arena.ts";
import type { ArenaResult, Outcome } from "../sim/arena.ts";
import type { Player } from "../sim/model.ts";
import { PRESET_ORDER, buildPreset } from "../sim/presets.ts";
import * as Pitch from "./match3d.ts";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`練習場の画面に #${id} が無い`);
  return n as T;
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  GOAL: "ゴール", SAVED: "枠外／セーブ", WON: "奪われた", OUT: "区切りの外へ", TIME: "時間切れ",
};

/** 選べる選手（プリセット6チームの全員）。キーは「チーム名/選手名」 */
const pool = new Map<string, Player>();
for (const name of PRESET_ORDER) {
  for (const p of buildPreset(name).players) pool.set(`${name}/${p.name}`, p);
}

function fill(sel: HTMLSelectElement, filter: (p: Player) => boolean, initial: string): void {
  for (const [key, p] of pool) {
    if (!filter(p)) continue;
    const o = document.createElement("option");
    o.value = key;
    o.textContent = `${p.name}（${p.position}・速${p.speed} 技${p.technique} 体${p.physical} 蹴${p.kick}）`;
    sel.append(o);
  }
  if (![...sel.options].some((o) => o.value === initial)) throw new Error(`初期の選手が見つからない: ${initial}`);
  sel.value = initial;
}

function pick(sel: HTMLSelectElement): Player {
  const p = pool.get(sel.value);
  if (p === undefined) throw new Error(`選手が見つからない: ${sel.value}`);
  return p;
}

let result: ArenaResult | null = null;

function run(): void {
  const seed = Number.parseInt($<HTMLInputElement>("seed").value, 10);
  const n = Number.parseInt($<HTMLInputElement>("n").value, 10);
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`シードは0以上の整数: ${$<HTMLInputElement>("seed").value}`);
  if (!Number.isInteger(n) || n < 2) throw new Error(`攻撃の回数は2以上の整数: ${$<HTMLInputElement>("n").value}`);
  const a = pick($<HTMLSelectElement>("pa"));
  const b = pick($<HTMLSelectElement>("pb"));
  if (a === b) throw new Error("選手AとBは別の選手にする");
  result = playArena(a, b, pick($<HTMLSelectElement>("gk")), seed, n);

  const log = $("log");
  log.replaceChildren();
  for (const [who, outcome, secs] of result.attacks) {
    const li = document.createElement("li");
    li.textContent = `${result.names[who]} の攻撃 → ${OUTCOME_LABEL[outcome]}（${secs}秒）`;
    log.append(li);
  }
  const r = result;
  Pitch.load(r.replay, r.events, r.names[0], {
    onUpdate: (s) => {
      $("score").textContent = `${r.names[0]} ${s.home} - ${s.away} ${r.names[1]}`;
    },
  });
}

function main(): void {
  fill($<HTMLSelectElement>("pa"), (p) => p.position !== "GK", "裏抜け型/裏抜け型FW1");
  fill($<HTMLSelectElement>("pb"), (p) => p.position !== "GK", "堅守型/堅守型DF1");
  fill($<HTMLSelectElement>("gk"), (p) => p.position === "GK", "バランス型/バランス型GK1");
  Pitch.attach($<HTMLCanvasElement>("view3d"));
  Pitch.attachMini($<HTMLCanvasElement>("mini"));
  $("runBtn").addEventListener("click", guard(run));
  $("playBtn").addEventListener("click", guard(() => {
    $("playBtn").textContent = Pitch.toggle() ? "一時停止" : "再生";
  }));
  $<HTMLInputElement>("speed").addEventListener("input", guard(() => {
    const v = Number($<HTMLInputElement>("speed").value) / 100;
    Pitch.setSpeed(v);
    $("speedVal").textContent = `${v.toFixed(1)}x`;
  }));
  run();
}

/** 例外を画面に出す（黙って止まらない） */
function guard(f: () => void): () => void {
  return () => {
    try {
      f();
    } catch (e) {
      const box = $("err");
      box.hidden = false;
      box.textContent = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
      throw e;
    }
  };
}

guard(main)();
