/**
 * スタジアムの周り（観客席・観客・外壁・照明塔・広告板）を3Dで描く。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ背景も3Dにするのか（2026-10-03）
 * ─────────────────────────────────────────────────────────────
 * 選手とピッチを3Dにしてカメラが自由に回るようになった時点で、
 * **背景が2Dだと破綻する**。カメラを回しても観客席が回らないので、
 * 「書き割りの前で人形が動いている」ように見える。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 速さの作り（ここを外すと一気に重くなる）
 * ─────────────────────────────────────────────────────────────
 * 観客は**1人2枚の面**しか描かない（体＋頭。箱の6面を描くと3倍になる）。
 * 席の段は長い箱にまとめる（1席ずつ箱にしない）。
 * 画面の外に出たものは投影した時点で捨てる。
 *
 * 🔴 **1人あたりの面を増やしてはいけない。** 1コマで1,400人ぶん回るので、
 *    全員に1枚足すと面が1,400枚増える。腕・旗・フラッシュは
 *    「番号で選ばれた少数だけ」に限ってある（`wob` の剰余でふるい分ける）。
 *
 * 🔴 ここもゲームの規則を持たない。🔑 乱数を引かない（番号から作る）。
 */

import { basisOf, isFrontFacing, project, projectPoly } from "./voxel.ts";
import type { Basis, Cam, P2, Vec3 } from "./voxel.ts";
import { PITCH_X, PITCH_Y } from "./field3d.ts";

/* ピッチの外側の余白（走路と広告板）。ここから観客席が立ち上がる */
const MARGIN = 7.5;
const TIERS = 5;            // 段の数
const TIER_D = 3.4;         // 1段の奥行き（m）
const TIER_H = 2.0;         // 1段の高さ（m）
/** 最上段の外側。ここから外壁が立ち上がる */
const OUTER = MARGIN + TIERS * TIER_D;
const WALL_T = 1.6;         // 外壁の厚み（m）
const WALL_H = TIERS * TIER_H + 3.5;   // 外壁の高さ（m）。最上段より少し高く
/** 照明塔の灯りの高さ（m）。夜のにじみを置く位置にも使う */
const LAMP_Z = 32;

/**
 * 画面から切り替える設定。
 *
 * 🔑 `voxel.ts` の `SHAPE` と同じやり方。`pitch3d.html` には夜のつまみが無いので、
 *    見比べたいときはここの既定値を書き換える（＝再読み込みで切り替わる）。
 *    `draw` に `night` を渡した場合は**引数が勝つ**（試合画面がキックオフ時刻から
 *    決めたいときのため）。既定は昼。
 */
export const SETTINGS = { night: false };

const C = {
  sky: ["#4ea8e6", "#86c9f0", "#bfe4f7"],
  /* 🔑 夜空は**上を思いきり暗く**する。中間調でまとめると「曇りの昼」に見えて、
        照明塔が光っている理由が画面から読めない */
  skyNight: ["#060c1e", "#0e1b3a", "#1d3358"],
  track: "#c3573f",
  concrete: "#9aa4b6",
  concreteDk: "#6f7a8e",
  seat: "#3a4f7a",
  seatDk: "#2a3a5c",
  roofLite: "#424e74",
  tower: "#5c6678",
  lamp: "#fff6d8",
  ad: ["#2f7ed8", "#e2574c", "#f0a01e", "#f2f6fb"],
  /* 🔴 **主色を配列の中で重ねる**（2026-10-03 の目視）。
        5色を等確率で引いていたので、ホーム側にも淡色と白が同じ割合で混ざり、
        「どちら側の客席か」が引きで読めなかった。主色を3回入れて半分を主色にする。 */
  home: ["#1b57c8", "#1b57c8", "#1b57c8", "#2f6fd6", "#5b93e4", "#eaf1fb"],
  away: ["#cc2329", "#cc2329", "#cc2329", "#d8343a", "#e4686c", "#1b1b1f"],
  neutral: ["#f2c230", "#4fae5a", "#9aa3ad", "#6b4fa0", "#e9e2d0"],
  skin: ["#f3cfaa", "#e0b089", "#b37a52", "#7a4a2e"],
};

const wob = (i: number, n: number): number => ((i * 2654435761) >>> 0) % n;
const pick = <T>(a: readonly T[], i: number): T => a[wob(i, a.length)]!;

function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** 2色を混ぜる。席をチーム色に寄せるのに使う（染めすぎると観客が席に溶ける） */
function mix(a: string, bHex: string, k: number): string {
  const x = Number.parseInt(a.slice(1), 16);
  const y = Number.parseInt(bHex.slice(1), 16);
  const ch = (sh: number): number => Math.round(
    ((x >> sh) & 255) + (((y >> sh) & 255) - ((x >> sh) & 255)) * k);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/* 面の明るさ。`voxel.ts` と同じ規則にそろえる（光の向きがずれると立体が崩れる） */
const FACES: { idx: [number, number, number, number]; lit: number }[] = [
  { idx: [4, 5, 7, 6], lit: 1.00 },
  { idx: [2, 6, 7, 3], lit: 0.86 },
  { idx: [1, 5, 4, 0], lit: 0.68 },
  { idx: [3, 7, 5, 1], lit: 0.78 },
  { idx: [0, 4, 6, 2], lit: 0.62 },
];

interface Face { q: P2[]; d: number; color: string }

/**
 * 箱を1つ積む。
 * @param top 上の面だけ別の色にしたいとき（段の上＝座席、側面＝コンクリート）
 */
function pushBox(out: Face[], b: Basis, cam: Cam, min: Vec3, max: Vec3,
                 color: string, top?: string): void {
  const corner = (i: number): Vec3 => ({
    x: i & 1 ? max.x : min.x,
    y: i & 2 ? max.y : min.y,
    z: i & 4 ? max.z : min.z,
  });
  for (const f of FACES) {
    const base = f.lit === 1.00 && top !== undefined ? top : color;
    /* 🔴 **切ってから描く**。観客席や走路は数十mあるので、角が1つカメラの後ろに
          入っただけで面ごと捨てると、近寄った途端にスタンドが消える */
    const q = projectPoly(b, cam, f.idx.map(corner));
    if (q === null) continue;
    if (!isFrontFacing(q)) continue;           // 裏面
    let d = 0;
    for (const p of q) d += p.d;
    out.push({ q, d: d / q.length, color: shade(base, f.lit) });
  }
}

/**
 * 布（旗・横断幕）を1枚積む。
 *
 * 🔑 箱と違って**裏表を見ない**。布は両面に絵があるものなので、裏を向いた瞬間に
 *    消えると「旗が点滅する」ように見える。
 * 🔑 深さを少し手前へ寄せる。段の面に貼り付けてあるため、並べ替えの丸めで
 *    段に負けると**横断幕がコンクリートの中に埋まる**。
 */
function pushCloth(out: Face[], b: Basis, cam: Cam, pts: Vec3[], color: string): void {
  const q = projectPoly(b, cam, pts);
  if (q === null) return;
  let d = 0;
  for (const p of q) d += p.d;
  out.push({ q, d: d / q.length - 0.12, color });
}

/** 観客1人ぶんの見た目の指定。引数が8個を超えたので束ねた（取り違えを防ぐ） */
interface FanLook {
  /** 色にかける係数。夜は暗く沈ませる */
  dim: number;
  /** 無地（中立色）を引く確率の分母。小さいほど混ざる＝ハーフウェイ付近 */
  neutralN: number;
  /** 腕を上げるか。盛り上がりで選ばれた少数だけ true */
  armsUp: boolean;
  /** カメラのフラッシュを光らせるか（夜＋盛り上がりのときだけ） */
  flash: boolean;
}

/**
 * 観客1人。**体と頭の2枚だけ**描く（6面描くと3倍になる）。
 *
 * 🔑 `axis` は体の幅を伸ばす向き。南北のスタンドは x 方向、東西のスタンドは y 方向。
 *    これを間違えると、東西の観客が**真横を向いて線になる**。
 */
function pushFan(out: Face[], b: Basis, cam: Cam, x: number, y: number, z: number,
                 i: number, bob: number, side: "home" | "away",
                 axis: "x" | "y", look: FanLook): void {
  const w = 0.30;
  const h = 0.78 + wob(i, 3) * 0.06;
  const raw = wob(i, look.neutralN) === 0
    ? pick(C.neutral, i)
    : pick(side === "home" ? C.home : C.away, i);
  const body = look.dim === 1 ? raw : shade(raw, look.dim);
  const z0 = z + bob;
  /**
   * 下端の半幅 `r0`・上端の半幅 `r1` の板を、`axis` の向きに張って
   * z0+a から z0+bz まで立てる。
   * 🔑 上下で幅を変えられるようにしてあるのは、**腕を上げた形を面を増やさずに
   *    出す**ため（上を広げると、肩から腕が開いた輪郭になる）。
   */
  const slab = (r0: number, r1: number, a: number, bz: number): P2[] | null => {
    const pts: Vec3[] = axis === "x"
      ? [{ x: x - r0, y, z: z0 + a }, { x: x + r0, y, z: z0 + a },
         { x: x + r1, y, z: z0 + bz }, { x: x - r1, y, z: z0 + bz }]
      : [{ x, y: y - r0, z: z0 + a }, { x, y: y + r0, z: z0 + a },
         { x, y: y + r1, z: z0 + bz }, { x, y: y - r1, z: z0 + bz }];
    const q: (P2 | null)[] = pts.map((p) => project(b, cam, p));
    if (q.some((v) => v === null)) return null;
    return q as P2[];
  };
  /* 腕を上げると肩のあたりが外へ広がる。倍率は控えめ（広げすぎると人に見えない） */
  const top = look.armsUp ? w * 1.55 : w;
  const bodyQ = slab(w, top, 0, h);
  if (bodyQ === null) return;
  const d = (bodyQ[0]!.d + bodyQ[1]!.d + bodyQ[2]!.d + bodyQ[3]!.d) / 4;
  out.push({ q: bodyQ, d, color: body });
  const skinRaw = pick(C.skin, i + 5);
  const headQ = slab(w * 0.62, w * 0.62, h, h + 0.34);
  if (headQ === null) return;
  out.push({ q: headQ, d: d - 0.01,
             color: look.dim === 1 ? skinRaw : shade(skinRaw, look.dim) });
  /* 🔑 夜のカメラのフラッシュ。1枚だけ白い小さな面を頭の横に出す。
        🔴 これは**選ばれた少数だけ**（`flash` の判定を呼び出し側で絞ってある）。
           全員に出すと真っ白な壁になり、しかも面が1.5倍になる。 */
  if (look.flash) {
    const fq = slab(w * 0.18, w * 0.18, h + 0.10, h + 0.26);
    if (fq !== null) out.push({ q: fq, d: d - 0.02, color: "#fffdf2" });
  }
}

/**
 * 旗。**竿1枚＋布1枚の2枚だけ**。
 *
 * 🔴 数を増やさない（呼び出し側で `wob` の剰余でふるってある）。
 *    客席いっぱいに旗を立てると、観客が旗の裏に隠れて「何人いるのか」が読めない。
 */
function pushFlag(out: Face[], b: Basis, cam: Cam, x: number, y: number, z: number,
                  i: number, t: number, color: string, axis: "x" | "y",
                  sway: number): void {
  const poleH = 1.9;
  const len = 1.15;                                  // 布の長さ（m）
  const dirSign = wob(i + 3, 2) === 0 ? 1 : -1;      // 旗を張る向き（左右）
  /* 揺れ。🔑 位相は番号から作る（`t` だけで揺らすと客席の旗が**一斉に同じ形**になる） */
  const ph = wob(i, 64) * 0.098;
  const waveZ = Math.sin(t * 2.3 + ph) * (0.16 + sway * 0.22);
  const waveN = Math.cos(t * 1.9 + ph) * (0.18 + sway * 0.26);   // 面の法線方向へのはためき
  const zTop = z + poleH;
  const zLow = z + poleH * 0.55;
  const at = (dx: number, dn: number, zz: number): Vec3 => (axis === "x"
    ? { x: x + dx, y: y + dn, z: zz }
    : { x: x + dn, y: y + dx, z: zz });
  /* 竿。細い板1枚。立っているだけなので揺らさない（揺らすと布と位相がずれて折れて見える） */
  pushCloth(out, b, cam, [
    at(-0.035, 0, z), at(0.035, 0, z), at(0.035, 0, zTop), at(-0.035, 0, zTop),
  ], shade(color, 0.45));
  /* 布 */
  const far = len * dirSign;
  pushCloth(out, b, cam, [
    at(0, 0, zLow), at(far, waveN, zLow + waveZ),
    at(far, waveN, zTop + waveZ * 0.6), at(0, 0, zTop),
  ], color);
}

/* 席の向き: 0=南(y<0) 1=北(y>PITCH_Y) 2=西(x<0) 3=東(x>PITCH_X) */
const SIDES = [0, 1, 2, 3] as const;

/**
 * スタジアムの周りを描く。
 *
 * 🔴 **ピッチより先に呼ぶ。** 観客席はピッチの外にあるので重ならないが、
 *    外壁と照明塔は空に届くため、先に描かないと空で塗りつぶされる。
 * @param t 秒。観客の揺れに使う
 * @param excite 盛り上がり 0〜1。1に近いほど大きく跳ね、腕が上がり、旗が揺れる。
 *   ゴールの瞬間に1を渡す。**省略すると 0**＝落ち着いた客席（既存の見た目）。
 * @param night 夜にするか。省略すると `SETTINGS.night`（既定は昼）
 */
export function draw(c: CanvasRenderingContext2D, cam: Cam, t: number,
                     excite?: number, night?: boolean): void {
  /* 🔴 おかしな入力は**弾く**。`t` が NaN になると全部の面が画面外へ飛んで
        「客席が消えた」としか分からなくなる（原因を画面に出すほうが早い）。 */
  if (!Number.isFinite(t)) {
    throw new Error(`stadium3d.draw: t（秒）に ${String(t)} が来た。数でなければ描けない`);
  }
  if (excite !== undefined && !(Number.isFinite(excite) && excite >= 0 && excite <= 1)) {
    throw new Error(`stadium3d.draw: excite は 0〜1 で渡す（来た値: ${String(excite)}）`);
  }
  const ex = excite ?? 0;
  const isNight = night ?? SETTINGS.night;
  /* 🔑 夜は**席より観客を明るく**残す。同じ係数で落とすと客席が真っ黒な板になり、
        「人が入っていない競技場」に見える。見せたいのは観客。 */
  const dim = isNight ? 0.38 : 1;
  const fanDim = isNight ? 0.62 : 1;
  const col = (hex: string): string => (isNight ? shade(hex, dim) : hex);

  const b = basisOf(cam);

  /* 空。3段に割る（なめらかにすると現代のUIになる） */
  const sky = isNight ? C.skyNight : C.sky;
  const g = c.createLinearGradient(0, 0, 0, c.canvas.height);
  g.addColorStop(0, sky[0]!);
  g.addColorStop(0.55, sky[1]!);
  g.addColorStop(1, sky[2]!);
  c.fillStyle = g;
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);

  const faces: Face[] = [];

  /* 走路（ピッチの外周） */
  const tx0 = -MARGIN;
  const tx1 = PITCH_X + MARGIN;
  const ty0 = -MARGIN;
  const ty1 = PITCH_Y + MARGIN;
  pushBox(faces, b, cam, { x: tx0, y: ty0, z: -0.02 }, { x: tx1, y: ty1, z: 0 },
          col(C.track));

  for (const side of SIDES) {
    const horiz = side < 2;                     // 南北＝長辺に沿う
    /* 🔑 東西のスタンドは**席までチーム色に寄せる**。観客の色だけだと、引きで
          人が小さくなった時点でホームとアウェーの区別が消える（2026-10-03 の目視）。
          染めすぎると観客が席に溶けるので 0.3 まで。 */
    const teamSeat = side === 2 ? C.home[0]! : C.away[0]!;
    for (let i = 0; i < TIERS; i++) {
      const off = MARGIN + i * TIER_D;
      const zTop = (i + 1) * TIER_H;
      /* 段（コンクリートの長い箱）と、その上の席の面 */
      let min: Vec3;
      let max: Vec3;
      /* 🔴 段は**額縁**として噛み合わせる。南北の箱は、その段の外周ぶんだけ
            横に伸ばす（固定幅で伸ばすと、内側の段が東西のスタンドを突き抜けて
            ピッチの上に灰色の板が乗る。2026-10-03 の目視で発見）。 */
      const span = off + TIER_D;
      if (side === 0) {
        min = { x: -span, y: -off - TIER_D, z: 0 };
        max = { x: PITCH_X + span, y: -off, z: zTop };
      } else if (side === 1) {
        min = { x: -span, y: PITCH_Y + off, z: 0 };
        max = { x: PITCH_X + span, y: PITCH_Y + off + TIER_D, z: zTop };
      } else if (side === 2) {
        min = { x: -off - TIER_D, y: ty0, z: 0 };
        max = { x: -off, y: ty1, z: zTop };
      } else {
        min = { x: PITCH_X + off, y: ty0, z: 0 };
        max = { x: PITCH_X + off + TIER_D, y: ty1, z: zTop };
      }
      /* 🔑 側面＝コンクリート／上面＝座席。同じ色で積むと段差が読めず、
            灰色の坂が1枚あるようにしか見えない（2026-10-03 の目視） */
      const seatRaw = i % 2 === 0 ? C.seat : C.seatDk;
      const seat = horiz ? seatRaw : mix(seatRaw, teamSeat, 0.3);
      pushBox(faces, b, cam, min, max, col(i % 2 === 0 ? C.concrete : C.concreteDk),
              col(seat));

      /* 観客。段の上に並べる。🔑 ホーム側とアウェー側で色の寄りを変える */
      const step = 1.25;
      if (horiz) {
        const y = side === 0 ? min.y + TIER_D * 0.45 : max.y - TIER_D * 0.45;
        for (let x = min.x + 1; x < max.x; x += step) {
          const n = Math.round(x * 7 + i * 131 + side * 17);
          if (wob(n, 12) === 0) continue;                 // 空席
          /* 🔑 ハーフウェイ付近だけ色を混ぜる。ここを境に青と赤が入れ替わるので、
                混ざる帯があると「どちらの陣地か」が逆に読みやすくなる */
          const mixed = Math.abs(x - PITCH_X / 2) < 9;
          const fanSide = x < PITCH_X / 2 ? "home" : "away";
          drawFan(faces, b, cam, x, y, zTop, n, t, ex, fanDim, mixed, fanSide, "x",
                  isNight);
        }
      } else {
        const x = side === 2 ? min.x + TIER_D * 0.45 : max.x - TIER_D * 0.45;
        for (let y = min.y + 1; y < max.y; y += step) {
          const n = Math.round(y * 11 + i * 97 + side * 29);
          if (wob(n, 12) === 0) continue;
          drawFan(faces, b, cam, x, y, zTop, n, t, ex, fanDim, false,
                  side === 2 ? "home" : "away", "y", isNight);
        }
      }

      /* 横断幕。段の**前の壁**（ピッチ側の立ち上がり）に垂らす。
         🔑 数は控えめに。全段に入れると客席が布だらけになって観客が読めないので、
            2段目と4段目だけ・24mおきの候補のうち3つに1つ（＝全体で6〜8枚）にしてある。 */
      if (i === 1 || i === 3) {
        const zBase = i * TIER_H;
        if (horiz) {
          for (let x = min.x + 10; x < max.x - 10; x += 24) {
            const n = Math.round(x * 3 + i * 211 + side * 7);
            if (wob(n, 3) !== 0) continue;
            pushBanner(faces, b, cam, x, side === 0 ? max.y + 0.06 : min.y - 0.06,
                       zBase, n, t, ex, dim, "x", side === 0 ? 1 : -1,
                       /* 🔑 観客の色の寄せ方と同じ規則にそろえる（長辺は左右で分ける） */
                       x < PITCH_X / 2 ? "home" : "away");
          }
        } else {
          for (let y = min.y + 10; y < max.y - 10; y += 24) {
            const n = Math.round(y * 3 + i * 211 + side * 7);
            if (wob(n, 3) !== 0) continue;
            pushBanner(faces, b, cam, y, side === 2 ? max.x + 0.06 : min.x - 0.06,
                       zBase, n, t, ex, dim, "y", side === 2 ? 1 : -1,
                       /* 🔑 短辺（ゴール裏）は、西＝ホーム／東＝アウェーで丸ごと分ける */
                       side === 2 ? "home" : "away");
          }
        }
      }
    }

    /* 🔴 **屋根ではなく外壁**にする（2026-10-03 の目視）。
          最上段の上に庇を張ると、支柱が無いので空中に細い梁が1本走っているだけに見え、
          しかもカメラを上げると観客を隠す。見せたいのは観客なので、
          スタンドの背中を壁で閉じて「外から見ても建物」にするほうが効く。 */
    const back = OUTER;
    if (side === 0) {
      pushBox(faces, b, cam,
              { x: -back - WALL_T, y: -back - WALL_T, z: 0 },
              { x: PITCH_X + back + WALL_T, y: -back, z: WALL_H },
              col(C.concreteDk), col(C.roofLite));
    } else if (side === 1) {
      pushBox(faces, b, cam,
              { x: -back - WALL_T, y: PITCH_Y + back, z: 0 },
              { x: PITCH_X + back + WALL_T, y: PITCH_Y + back + WALL_T, z: WALL_H },
              col(C.concreteDk), col(C.roofLite));
    } else if (side === 2) {
      pushBox(faces, b, cam,
              { x: -back - WALL_T, y: -back - WALL_T, z: 0 },
              { x: -back, y: PITCH_Y + back + WALL_T, z: WALL_H },
              col(C.concrete), col(C.roofLite));
    } else {
      pushBox(faces, b, cam,
              { x: PITCH_X + back, y: -back - WALL_T, z: 0 },
              { x: PITCH_X + back + WALL_T, y: PITCH_Y + back + WALL_T, z: WALL_H },
              col(C.concrete), col(C.roofLite));
    }
  }

  /* 広告板。ピッチをぐるりと囲むと一気に「試合会場」になる。
     🔑 夜も**広告板は落とさない**。自分で光る板なので、暗くすると逆に嘘になる */
  for (let x = 0; x < PITCH_X; x += 6) {
    const colA = pick(C.ad, Math.round(x));
    pushBox(faces, b, cam, { x, y: -2.2, z: 0 }, { x: x + 5.4, y: -1.9, z: 1.1 }, colA);
    pushBox(faces, b, cam, { x, y: PITCH_Y + 1.9, z: 0 },
            { x: x + 5.4, y: PITCH_Y + 2.2, z: 1.1 }, pick(C.ad, Math.round(x) + 2));
  }

  /* 照明塔。4隅。これがあると「大きな競技場」に見える */
  const towerOut = OUTER + WALL_T + 2.5;   // 外壁のさらに外に立てる
  const lamps: Vec3[] = [];
  for (const [cxm, cym] of [[-towerOut, -towerOut], [PITCH_X + towerOut, -towerOut],
                            [-towerOut, PITCH_Y + towerOut],
                            [PITCH_X + towerOut, PITCH_Y + towerOut]]) {
    pushBox(faces, b, cam, { x: cxm! - 0.9, y: cym! - 0.9, z: 0 },
            { x: cxm! + 0.9, y: cym! + 0.9, z: LAMP_Z - 2 }, col(C.tower));
    /* 🔑 灯りの箱は夜も暗くしない。ここだけ明るいから「光っている」と読める */
    pushBox(faces, b, cam, { x: cxm! - 4.5, y: cym! - 1.4, z: LAMP_Z - 2 },
            { x: cxm! + 4.5, y: cym! + 1.4, z: LAMP_Z + 2 }, C.lamp);
    lamps.push({ x: cxm!, y: cym!, z: LAMP_Z });
  }

  /* 🔴 奥から手前へ。これを飛ばすと、手前の段の裏に奥の観客が出る */
  faces.sort((m, n) => n.d - m.d);
  for (const f of faces) {
    c.beginPath();
    c.moveTo(f.q[0]!.x, f.q[0]!.y);
    for (let i = 1; i < f.q.length; i++) c.lineTo(f.q[i]!.x, f.q[i]!.y);
    c.closePath();
    c.fillStyle = f.color;
    c.fill();
    c.strokeStyle = f.color;
    c.lineWidth = 1;
    c.stroke();
  }

  /* 夜の照明のにじみ。
     🔴 **面を全部描いたあと**に重ねる。面の並べ替えに混ぜると、
        奥の段に塗りつぶされて光って見えない。
     🔑 ピッチ（`field3d`）はこのあとに描かれるが、灯りは地平線より高い位置なので
        芝で消されることはない。 */
  if (isNight) {
    for (const lp of lamps) {
      const p = project(b, cam, lp);
      if (p === null) continue;
      /* 画面上の大きさは距離で決まる。近寄ったときに画面を覆わないよう上限を置く */
      const r = Math.min(640, Math.max(6, (cam.focal / p.d) * 13));
      const halo = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      halo.addColorStop(0, "rgba(255, 250, 222, .55)");
      halo.addColorStop(0.3, "rgba(255, 242, 186, .22)");
      halo.addColorStop(1, "rgba(255, 240, 180, 0)");
      c.fillStyle = halo;
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fill();
    }
  }
}

/**
 * 観客1人を積む。揺れ・腕・旗・フラッシュの「誰がやるか」をここで決める。
 *
 * 🔑 分けた理由: 南北スタンドと東西スタンドで同じ判定を2か所に書いていたため、
 *    片方だけ直して**客席の半分が盛り上がらない**ことになりやすい。
 */
function drawFan(out: Face[], b: Basis, cam: Cam, x: number, y: number, z: number,
                 n: number, t: number, ex: number, dim: number, mixed: boolean,
                 side: "home" | "away", axis: "x" | "y", isNight: boolean): void {
  /* 跳ね。🔑 `ex === 0` のとき係数が元のまま（0.14・4+wob）になるようにしてある。
        盛り上がりを渡さない呼び出し元の見た目を変えないため。 */
  const amp = 0.14 + ex * 0.30;
  const spd = 4 + wob(n, 4) + ex * 3.5;
  const bob = Math.max(0, Math.sin(t * spd + n)) * amp;
  /* 腕を上げる人。🔴 **全員には出さない**（1人あたり面が増えるのではなく輪郭が
        広がるだけだが、全員が広がると人の形が消えて「ぎざぎざの帯」になる） */
  const armsUp = ex > 0.1 && wob(n + 7, 16) < ex * 9 && Math.sin(t * spd + n) > -0.2;
  /* 夜のフラッシュ。盛り上がったときだけ・2.5%の人だけ・一瞬だけ */
  const flash = isNight && ex > 0.3
    && wob(n + 31, 40) === 0 && Math.sin(t * 9 + n * 1.7) > 0.86;
  pushFan(out, b, cam, x, y, z, n, bob, side, axis,
          { dim, neutralN: mixed ? 3 : 10, armsUp, flash });
  /* 旗。🔴 64人に1人だけ（約20本）。増やすと客席が読めないうえ、
        布は面の並べ替えで手前へ寄せてあるので観客を隠す */
  if (wob(n + 13, 64) === 0) {
    const flagCol = pick(side === "home" ? C.home : C.away, n + 1);
    pushFlag(out, b, cam, x, y, z + 0.1, n, t,
             dim === 1 ? flagCol : shade(flagCol, Math.min(1, dim + 0.18)), axis, ex);
  }
}

/**
 * 横断幕を1枚。段の前の壁に垂らした布。
 *
 * @param along 幕の中心（`axis` が x なら x 座標、y なら y 座標）
 * @param at 壁の位置（`axis` が x なら y 座標、y なら x 座標）
 * @param faceSign ピッチがどちら側にあるか（+1 なら `at` より大きいほう）。
 *   🔴 これを取り違えると、幕が**段の中に埋まって見えなくなる**。
 */
function pushBanner(out: Face[], b: Basis, cam: Cam, along: number, at: number,
                    zBase: number, n: number, t: number, ex: number, dim: number,
                    axis: "x" | "y", faceSign: number,
                    sup: "home" | "away"): void {
  const half = 2.3;                               // 幕の半分の長さ（m）
  const zTop = zBase + TIER_H * 0.92;
  const zLow = zBase + TIER_H * 0.10;
  /* 揺れ。下端だけを前後に泳がせる（上端は結んであるので動かない） */
  const ph = wob(n, 32) * 0.196;
  const sw = (0.07 + ex * 0.16) * faceSign;
  const d0 = Math.sin(t * 1.6 + ph) * sw;
  const d1 = Math.sin(t * 1.6 + ph + 1.1) * sw;
  /* 🔴 **幕の色は垂れているスタンドで決める**（2026-10-03 のレビューで直した）。
        以前は `wob(n, 2)` で色を引いていたので、ホーム側のスタンドにアウェーの幕が垂れていた。
        乱数ではないので毎回同じ並びになり、**引きで見たとき「どちらのゴール裏か」の
        判断材料が嘘になる**。席をチーム色へ寄せて稼いだ読みやすさを、
        客席でいちばん大きく目立つ布が逆向きに潰していた。 */
  const base = pick(sup === "home" ? C.home : C.away, n + 2);
  const color = dim === 1 ? base : shade(base, Math.min(1, dim + 0.22));
  const pt = (a: number, off: number, zz: number): Vec3 => (axis === "x"
    ? { x: along + a, y: at + off, z: zz }
    : { x: at + off, y: along + a, z: zz });
  pushCloth(out, b, cam, [
    pt(-half, d0, zLow), pt(half, d1, zLow), pt(half, 0, zTop), pt(-half, 0, zTop),
  ], color);
  /* 🔑 下に細い帯を1本足すだけで「布を2本吊った」ように見える。
        面は1枚なので数が増えても重くならない */
  pushCloth(out, b, cam, [
    pt(-half, d0 * 1.2, zLow - 0.22), pt(half, d1 * 1.2, zLow - 0.22),
    pt(half, d1, zLow), pt(-half, d0, zLow),
  ], shade(color, 0.7));
}
