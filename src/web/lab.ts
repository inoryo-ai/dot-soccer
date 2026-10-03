/**
 * 選手パーツの確認台（`web/lab.html`）。**検証用でゲーム本体には出ない。**
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 これは何のためのページか
 * ─────────────────────────────────────────────────────────────
 * 選手1体を、姿勢・向き・カメラ・体つきを変えながら**1体だけ**で見る台。
 * 試合画面の中で見ると、22人が重なって動いているので、
 * 「いまの蹴り方が変か」「頭が大きすぎないか」を1つずつ確かめられない。
 *
 * 🔴 ここもゲームの規則を1行も持たない。
 *
 * 🗑 2026-10-03: もとは**2Dドット絵と3Dの見比べ**ページだった。
 *    3Dに一本化した（D-33）ので、見比べる相手が無くなり、
 *    「選手パーツを単体で確かめる台」に作り変えた。
 */

import * as Voxel from "./voxel.ts";
import type { Pose } from "./voxel.ts";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`確認台に #${id} が無い`);
  return n as T;
}

/* 🔑 色は試合画面のホームと同じにする。条件を変えると見比べにならない */
const KIT: Voxel.Kit = {
  shirt: "#f2a714", shorts: "#3b2a1b", skin: "#f7cfa4",
  hair: "#3b2a1b", socks: "#f2a714", shoes: "#2b2b33",
};

/**
 * ボタンに出す姿勢。
 *
 * 🔴 **`Pose` に足した姿勢はここにも足す。** ここに無い姿勢はボタンが出ないので、
 *    「作ったのに一度も見ていない動き」になる（2026-10-03 まで kick・cheer・tired が
 *    まさにそれで、押しても**止まった絵**しか出ない状態に気づけなかった）。
 */
const POSES: { key: Pose; label: string }[] = [
  { key: "stand", label: "立つ" },
  { key: "run", label: "走る" },
  { key: "sprint", label: "全力" },
  { key: "hold", label: "持つ" },
  { key: "kick", label: "蹴る" },
  { key: "header", label: "競る" },
  { key: "tackle", label: "スライディング" },
  { key: "down", label: "倒れる" },
  { key: "cheer", label: "喜ぶ" },
  { key: "tired", label: "息切れ" },
];

/** 日本語ラベルを引く。自動選択のときに「いま何が選ばれたか」を画面に出すため */
function labelOf(p: Pose): string {
  const hit = POSES.find((q) => q.key === p);
  /* 🔴 既定値で誤魔化さない。ラベルが無い＝`POSES` への足し忘れなので、
        そのまま鍵の文字列を出して気づけるようにする */
  return hit?.label ?? `(ラベル未登録: ${p})`;
}

let pose: Pose = "run";
/** 自動選択。`pickPose()` に速さを流し込んで、姿勢の切り替わりを見る台 */
let auto = false;
let facing = (200 * Math.PI) / 180;
let camYaw = (90 * Math.PI) / 180;
let camPitch = (32 * Math.PI) / 180;
let speed = 1;
let spinning = false;

function renderPoseRow(): void {
  const row = $("poseRow");
  row.textContent = "";
  for (const p of POSES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chip${!auto && p.key === pose ? " is-on" : ""}`;
    b.textContent = p.label;
    b.addEventListener("click", () => { pose = p.key; auto = false; renderPoseRow(); });
    row.append(b);
  }
  /* 🔑 姿勢を選ぶ関数（`pickPose`）も**目で確かめられる**ようにしておく。
        試合画面はこれを呼ぶので、境目でガタつかないかはここで見るのがいちばん早い */
  const a = document.createElement("button");
  a.type = "button";
  a.className = `chip${auto ? " is-on" : ""}`;
  a.textContent = "自動（速さで切替）";
  a.addEventListener("click", () => { auto = !auto; renderPoseRow(); });
  row.append(a);
}

/**
 * 自動選択に流す速さ（m/s）。0.2〜7.0 を往復する。
 *
 * 🔴 乱数は引かない（D-16）。同じ `t` なら必ず同じ速さ＝同じ姿勢になる。
 * 🔴 **振れ幅を中心値と同じにしない。** `3.5 + 3.5*sin` だと谷で丸め誤差ぶんの
 *    マイナスが出ることがあり、`pickPose` が「速さは0以上」で例外を投げて
 *    描画のループごと止まる。中心より小さい振れ幅にしておく。
 */
function sweepSpeed(t: number): number {
  return 3.6 + 3.4 * Math.sin(t * 0.55);
}

function drawPlayer(t: number): void {
  const cv = $<HTMLCanvasElement>("newCanvas");
  const c = cv.getContext("2d");
  if (c === null) return;
  c.clearRect(0, 0, cv.width, cv.height);

  /* 足元の地面。何も敷かないと、浮いているのか立っているのか分からない */
  c.fillStyle = "#3f9e46";
  c.fillRect(0, 0, cv.width, cv.height);

  const cam: Voxel.Cam = {
    yaw: camYaw,
    pitch: camPitch,
    dist: 2.9,
    focal: 620,
    target: { x: 0, y: 0, z: 0.72 },
    cx: cv.width / 2,
    cy: cv.height * 0.56,
  };
  const at = { x: 0, y: 0, z: 0 };
  const now = t * speed;

  /* 自動選択のときは `pickPose()` に任せる。ボタンで選んだときはそのまま */
  const sp = sweepSpeed(now);
  const shown: Pose = auto ? Voxel.pickPose({ speed: sp, hasBall: false, tired: 0 }) : pose;

  /* 🔑 影にも姿勢を渡す。倒れている姿勢だけ影が後ろへ伸びる
        （体が1.5m 後ろに寝ているのに足元の丸のままだと浮いて見える） */
  Voxel.drawShadow(c, cam, at, { pose: shown, facing });
  Voxel.drawPlayer(c, cam, { at, facing, pose: shown, t: now, kit: KIT });

  if (auto) {
    /* 🔑 何が選ばれたかを**画面に出す**。選び方の境目（走る↔全力）は
          数字を見ないと詰められない */
    c.font = "bold 16px system-ui, sans-serif";
    c.lineWidth = 4;
    c.strokeStyle = "rgba(20, 40, 70, .85)";
    c.fillStyle = "#ffffff";
    const msg = `pickPose: ${labelOf(shown)}  （速さ ${sp.toFixed(1)} m/s）`;
    c.strokeText(msg, 12, 28);
    c.fillText(msg, 12, 28);
  }
}

function fmtDeg(rad: number): string {
  return `${Math.round(((rad * 180) / Math.PI + 360) % 360)}°`;
}

function main(): void {
  renderPoseRow();

  const bind = (id: string, valId: string, set: (v: number) => void,
                fmt: (v: number) => string): void => {
    const el = $<HTMLInputElement>(id);
    const out = $(valId);
    const apply = (): void => {
      set(Number(el.value));
      out.textContent = fmt(Number(el.value));
    };
    el.addEventListener("input", apply);
    apply();
  };
  bind("yaw", "yawVal", (v) => { facing = (v * Math.PI) / 180; }, (v) => `${v}°`);
  bind("camYaw", "camYawVal", (v) => { camYaw = (v * Math.PI) / 180; }, (v) => `${v}°`);
  bind("camPitch", "camPitchVal", (v) => { camPitch = (v * Math.PI) / 180; }, (v) => `${v}°`);
  bind("speed", "speedVal", (v) => { speed = v / 100; }, (v) => `${(v / 100).toFixed(2)}x`);

  $("spin").addEventListener("click", () => {
    spinning = !spinning;
    $("spin").textContent = spinning ? "回すのをやめる" : "カメラを回す";
  });

  /* 体つきのつまみ。`SHAPE` を直接書き換える（次のコマから反映される） */
  bind("headRatio", "headRatioVal",
       (v) => { Voxel.SHAPE.headRatio = v / 100; }, (v) => `${v}%`);
  bind("headWidth", "headWidthVal",
       (v) => { Voxel.SHAPE.headWidth = v / 100; }, (v) => `${(v / 100).toFixed(2)}m`);
  bind("bodyWidth", "bodyWidthVal",
       (v) => { Voxel.SHAPE.bodyWidth = v / 100; }, (v) => `${(v / 100).toFixed(2)}m`);
  bind("legRatio", "legRatioVal",
       (v) => { Voxel.SHAPE.legRatio = v / 100; }, (v) => `${v}%`);

  $("reset").addEventListener("click", () => {
    const d: [string, number][] = [["headRatio", 35], ["headWidth", 50],
                                   ["bodyWidth", 54], ["legRatio", 48]];
    for (const [id, v] of d) {
      const el = $<HTMLInputElement>(id);
      el.value = String(v);
      el.dispatchEvent(new Event("input"));
    }
  });

  const t0 = performance.now();
  const loop = (now: number): void => {
    requestAnimationFrame(loop);
    const t = (now - t0) / 1000;
    if (spinning) {
      camYaw = (t * 0.6) % (Math.PI * 2);
      const el = $<HTMLInputElement>("camYaw");
      el.value = String(Math.round((camYaw * 180) / Math.PI));
      $("camYawVal").textContent = fmtDeg(camYaw);
    }
    drawPlayer(t);
  };
  requestAnimationFrame(loop);
}

main();
