/**
 * 四角ブロックの2頭身選手を**3Dで**描く（検証中・2026-10-03）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ3Dにするのか
 * ─────────────────────────────────────────────────────────────
 * いまのドット絵は `8方向 × 4コマ × 5姿勢 = 160枚`を1枚ずつ描いている。
 * 動きを1つ足すたびに**8方向ぶん全部**描き直すので、姿勢の数に比例して費用が増える。
 * だから「蹴る」も「競る」も入っていない。
 *
 * 3Dなら、**モデルは1体・向きは投影が出す・動きは関節を回すだけ**。
 * 「蹴る」は脚を1本回せば終わりで、方向ぶんの描き直しが要らない。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 外部ライブラリを使わない（§6）
 * ─────────────────────────────────────────────────────────────
 * Three.js も WebGL も使わない。**箱を面に分けて、奥から手前へ塗るだけ**で足りる。
 * 1人6箱＝面36枚、見えるのは半分。22人でも canvas 2D で間に合う。
 * 🔑 GPU を使わないので、**同じ入力なら必ず同じ絵**になる（D-16 の決定論が保てる）。
 *
 * 🔑 色は面に塗るだけなので、商店街の着せ替え（GD-03）がそのまま生きる。
 */

/** 世界の座標。x=ピッチの長さ方向 / y=幅方向 / z=上 */
export interface Vec3 { x: number; y: number; z: number }

export interface Cam {
  yaw: number;      // 水平に振る角（ラジアン）
  pitch: number;    // 見下ろす角（0=水平・π/2=真上）
  dist: number;     // 注視点までの距離（m）
  focal: number;    // 画角。大きいほど寄る
  target: Vec3;     // 注視点
  cx: number;       // 画面の中心（px）
  cy: number;
}

export interface Kit {
  shirt: string;
  shorts: string;
  skin: string;
  hair: string;
  socks: string;
  shoes: string;
}

/** いまの動き。**見た目だけ**で、試合の結果には関わらない */
export type Pose = "stand" | "run" | "sprint" | "kick" | "cheer" | "tired";

/* ------------------------------------------------------------ 投影 */

interface Basis { eye: Vec3; right: Vec3; up: Vec3; fwd: Vec3 }

function basisOf(cam: Cam): Basis {
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const fwd = { x: cp * cy, y: cp * sy, z: -sp };
  const eye = {
    x: cam.target.x - fwd.x * cam.dist,
    y: cam.target.y - fwd.y * cam.dist,
    z: cam.target.z - fwd.z * cam.dist,
  };
  const rl = Math.hypot(fwd.y, -fwd.x) || 1;
  const right = { x: fwd.y / rl, y: -fwd.x / rl, z: 0 };
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  return { eye, right, up, fwd };
}

interface P2 { x: number; y: number; d: number }

function project(b: Basis, cam: Cam, p: Vec3): P2 | null {
  const vx = p.x - b.eye.x;
  const vy = p.y - b.eye.y;
  const vz = p.z - b.eye.z;
  const d = vx * b.fwd.x + vy * b.fwd.y + vz * b.fwd.z;
  if (d <= 0.2) return null;                 // カメラの後ろは描かない
  const sx = vx * b.right.x + vy * b.right.y + vz * b.right.z;
  const sy = vx * b.up.x + vy * b.up.y + vz * b.up.z;
  return { x: cam.cx + (cam.focal * sx) / d, y: cam.cy - (cam.focal * sy) / d, d };
}

/* ------------------------------------------------------------ 箱 */

/** 箱の8隅。中心と半径で持つ（回す前の、部品のローカル座標） */
interface Box {
  /* 関節の位置（体のローカル座標）。ここを軸に回す */
  joint: Vec3;
  /* 関節から見た箱の中心 */
  center: Vec3;
  half: Vec3;
  color: string;
  /* 関節まわりの回転。x軸＝前後に振る／z軸＝ひねる */
  rotX: number;
  rotZ: number;
}

/* 面の並び（8隅のうちどれを使うか）と、面ごとの明るさ。
   🔑 **面ごとに明るさを固定する。** 同じ色で塗ると、どれだけ積んでも
      平たい六角形にしか見えない（`iso.ts` で学んだのと同じ）。 */
const FACES: { idx: [number, number, number, number]; lit: number }[] = [
  { idx: [4, 5, 7, 6], lit: 1.00 },   // 上
  { idx: [0, 2, 3, 1], lit: 0.55 },   // 下
  { idx: [2, 6, 7, 3], lit: 0.86 },   // 前（+y）
  { idx: [1, 5, 4, 0], lit: 0.68 },   // 後（-y）
  { idx: [3, 7, 5, 1], lit: 0.78 },   // 右（+x）
  { idx: [0, 4, 6, 2], lit: 0.62 },   // 左（-x）
];

function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** 箱の8隅を世界座標へ。関節で回し、体の向きで回し、立ち位置へ運ぶ */
function corners(box: Box, facing: number, at: Vec3, lean: number): Vec3[] {
  const out: Vec3[] = [];
  const cx = Math.cos(box.rotX);
  const sx = Math.sin(box.rotX);
  const cz = Math.cos(box.rotZ);
  const sz = Math.sin(box.rotZ);
  const cf = Math.cos(facing);
  const sf = Math.sin(facing);
  const cl = Math.cos(lean);
  const sl = Math.sin(lean);
  for (let i = 0; i < 8; i++) {
    /* 箱のローカル（中心から見た隅） */
    let x = box.center.x + (i & 1 ? box.half.x : -box.half.x);
    let y = box.center.y + (i & 2 ? box.half.y : -box.half.y);
    let z = box.center.z + (i & 4 ? box.half.z : -box.half.z);
    /* 関節まわりのひねり（z軸） */
    let t = x * cz - y * sz;
    y = x * sz + y * cz;
    x = t;
    /* 関節まわりの前後振り（x軸）→ y と z が回る */
    t = y * cx - z * sx;
    z = y * sx + z * cx;
    y = t;
    /* 関節の位置へ戻す */
    x += box.joint.x;
    y += box.joint.y;
    z += box.joint.z;
    /* 体全体の前傾（x軸） */
    t = y * cl - z * sl;
    z = y * sl + z * cl;
    y = t;
    /* 体の向き（z軸） */
    t = x * cf - y * sf;
    y = x * sf + y * cf;
    x = t;
    out.push({ x: x + at.x, y: y + at.y, z: z + at.z });
  }
  return out;
}

/* ------------------------------------------------------- 体の作り */

/**
 * 2頭身。**頭が全高の半分**。
 * 🔑 寸法はメートル。試合の世界座標にそのまま置けるようにしてある。
 */
/* 🔴 頭は**立方体に近く**する（2026-10-03 の目視）。
      最初は 0.60幅 × 0.85高 で、2頭身ではなく「縦長の柱が乗った人」に見えた。
      幅と高さを揃えると、ブロックらしい頭になる。 */
/* 🔴 頭は**全高の4割**（2026-10-03 の目視で2回直した）。
      1回目 0.60幅×0.85高 → 縦長の柱に見えた。
      2回目 立方体にしたが 58% で、**頭が胴を覆って腕も脚も読めなくなった**。
      サッカーは体の動きを見るゲームなので、頭で隠してはいけない。40%が上限。 */
/**
 * 体つき。**ここは見ながら決める数字**なので、外から変えられるようにしてある
 * （`web/lab.html` のつまみが直接これを書き換える）。
 *
 * 🔑 コードの中で当てずっぽうに決めると、2回直しても合わなかった。
 *    実際に動かしながら触れるほうが早い。決まったらここの既定値を書き換える。
 */
export const SHAPE = {
  headRatio: 0.40,   // 頭が全高に占める割合
  headWidth: 0.58,   // 頭の幅（m）
  bodyWidth: 0.46,   // 胴の幅（m）
  total: 1.65,       // 全高（m）
  legRatio: 0.48,    // 脚（足元から腰まで）が「頭を除いた体」に占める割合
};

const H_TOTAL = (): number => SHAPE.total;
/** 脚のつけね */
const Z_LEG = (): number => SHAPE.total * (1 - SHAPE.headRatio) * SHAPE.legRatio;
/** 胴の上端＝頭のつけね */
const Z_TORSO = (): number => SHAPE.total * (1 - SHAPE.headRatio);

function body(kit: Kit, p: Pose, t: number): Box[] {
  /* 歩調。`t` は秒。走るほど速く振る */
  const cycle = p === "sprint" ? 11 : p === "run" ? 7.5 : p === "tired" ? 4.5 : 2.2;
  const s = Math.sin(t * cycle);
  const c = Math.cos(t * cycle);

  /* 振り幅 */
  const swing = p === "sprint" ? 1.05 : p === "run" ? 0.72 : p === "tired" ? 0.34 : 0.06;
  const armSw = p === "cheer" ? 0 : swing * 0.8;

  /* 上下動。走ると弾む */
  const bob = (p === "run" || p === "sprint" ? 0.055 : p === "cheer" ? 0.09 : 0.012)
              * Math.abs(s);
  /* 前傾。全力ほど前へ、息切れは前かがみ */
  const legL = s * swing;
  const legR = -s * swing;
  let armL = -s * armSw;
  let armR = s * armSw;

  if (p === "kick") {
    /* 🔑 蹴る: 右脚を**大きく前へ**、左腕を開いてバランスを取る。
          3Dだと脚を1本回すだけで済む（ドット絵なら8方向ぶん描き直し） */
    const k = Math.sin(Math.min(1, t * 6) * Math.PI);
    return parts(kit, -0.25 * k, 0.9 * k, -0.9 * k, 0.5 * k, bob * 0.3, -0.18 * k);
  }
  if (p === "cheer") {
    /* 両腕を上へ。喜びは**腕の形**で伝わる */
    const up = -2.5 - 0.25 * s;
    return parts(kit, 0.08 * s, -0.08 * s, up, up, 0.09 * Math.abs(s), 0);
  }
  if (p === "tired") {
    return parts(kit, legL, legR, armL * 0.5, armR * 0.5, bob, 0.30);
  }
  const lean = p === "sprint" ? 0.34 : p === "run" ? 0.18 : 0.02;
  armL += c * 0.04;
  armR -= c * 0.04;
  return parts(kit, legL, legR, armL, armR, bob, lean);
}

/** 6つの箱を組む。`lean` は体の前傾（呼び出し側で姿勢ごとに決める） */
function parts(kit: Kit, legL: number, legR: number, armL: number, armR: number,
               bob: number, lean: number): Box[] {
  const b = (joint: Vec3, center: Vec3, half: Vec3, color: string,
             rotX = 0, rotZ = 0): Box => ({ joint, center, half, color, rotX, rotZ });
  const z = bob;
  const zLeg = Z_LEG();
  const zTor = Z_TORSO();
  const hTot = H_TOTAL();
  const bw = SHAPE.bodyWidth / 2;          // 胴の半幅
  const hw = SHAPE.headWidth / 2;          // 頭の半幅
  const hz = (hTot - zTor) / 2;            // 頭の半分の高さ
  const legX = bw * 0.48;                  // 脚の左右の開き
  return [
    /* 脚（つけねで回す。箱はつけねから下へ伸びる） */
    b({ x: -legX, y: 0, z: zLeg + z }, { x: 0, y: 0, z: -zLeg / 2 },
      { x: bw * 0.42, y: bw * 0.46, z: zLeg / 2 }, kit.socks, legL),
    b({ x: legX, y: 0, z: zLeg + z }, { x: 0, y: 0, z: -zLeg / 2 },
      { x: bw * 0.42, y: bw * 0.46, z: zLeg / 2 }, kit.socks, legR),
    /* 短パン（胴の下。脚と一緒には振らない） */
    b({ x: 0, y: 0, z: zLeg + z }, { x: 0, y: 0, z: 0.07 },
      { x: bw, y: bw * 0.6, z: 0.09 }, kit.shorts),
    /* 胴 */
    b({ x: 0, y: 0, z: zLeg + z }, { x: 0, y: 0, z: (zTor - zLeg) / 2 + 0.06 },
      { x: bw, y: bw * 0.6, z: (zTor - zLeg) / 2 - 0.02 }, kit.shirt),
    /* 腕（肩で回す） */
    b({ x: -(bw + 0.05), y: 0, z: zTor - 0.04 + z }, { x: 0, y: 0, z: -0.19 },
      { x: 0.07, y: 0.08, z: 0.19 }, kit.skin, armL),
    b({ x: bw + 0.05, y: 0, z: zTor - 0.04 + z }, { x: 0, y: 0, z: -0.19 },
      { x: 0.07, y: 0.08, z: 0.19 }, kit.skin, armR),
    /* 頭。幅・奥行き・高さをほぼ揃えた立方体にする */
    b({ x: 0, y: 0, z: zTor + z }, { x: 0, y: 0, z: hz },
      { x: hw, y: hw * 0.92, z: hz }, kit.skin),
    /* 🔑 髪は**天面と後ろだけ**。前まで覆うと黒い板になって顔が消える */
    b({ x: 0, y: 0, z: zTor + z }, { x: 0, y: -0.03, z: hz * 2 - 0.09 },
      { x: hw * 1.02, y: hw * 0.86, z: 0.10 }, kit.hair),
    /* 靴 */
    b({ x: -legX, y: 0, z: zLeg + z }, { x: 0, y: 0.03, z: -zLeg + 0.04 },
      { x: bw * 0.46, y: bw * 0.6, z: 0.05 }, kit.shoes, legL),
    b({ x: legX, y: 0, z: zLeg + z }, { x: 0, y: 0.03, z: -zLeg + 0.04 },
      { x: bw * 0.46, y: bw * 0.6, z: 0.05 }, kit.shoes, legR),
  ];
  void lean;
}

/* ------------------------------------------------------------ 描く */

export interface DrawOpts {
  at: Vec3;        // 足元の位置（世界座標・m）
  facing: number;  // 体の向き（ラジアン）
  pose: Pose;
  t: number;       // 秒
  kit: Kit;
  lean?: number;   // 体の前傾
}

/**
 * 1人描く。
 *
 * 🔴 **面を奥から手前へ塗る。** 箱ごとに描くと、腕が胴を突き抜ける。
 *    全部の面を集めてから、面の中心の奥行きで並べ替える。
 */
export function drawPlayer(c: CanvasRenderingContext2D, cam: Cam, o: DrawOpts): void {
  const bs = basisOf(cam);
  const boxes = body(o.kit, o.pose, o.t);
  const lean = o.lean ?? 0;

  type Face = { pts: P2[]; d: number; color: string };
  const faces: Face[] = [];

  for (const box of boxes) {
    const w = corners(box, o.facing, o.at, lean);
    const p: (P2 | null)[] = w.map((v) => project(bs, cam, v));
    for (const f of FACES) {
      const q = f.idx.map((i) => p[i]);
      if (q.some((v) => v === null)) continue;
      const pts = q as P2[];
      /* 🔑 裏を向いている面は描かない。**画面上の回り方の向き**で判定する
            （法線を世界で計算するより、投影後の符号を見るほうが確実） */
      const area = (pts[1]!.x - pts[0]!.x) * (pts[2]!.y - pts[0]!.y)
                 - (pts[2]!.x - pts[0]!.x) * (pts[1]!.y - pts[0]!.y);
      if (area <= 0) continue;
      const d = (pts[0]!.d + pts[1]!.d + pts[2]!.d + pts[3]!.d) / 4;
      faces.push({ pts, d, color: shade(box.color, f.lit) });
    }
  }
  faces.sort((a, b) => b.d - a.d);

  for (const f of faces) {
    c.beginPath();
    c.moveTo(f.pts[0]!.x, f.pts[0]!.y);
    for (let i = 1; i < f.pts.length; i++) c.lineTo(f.pts[i]!.x, f.pts[i]!.y);
    c.closePath();
    c.fillStyle = f.color;
    c.fill();
    /* 🔑 面のあいだに髪の毛1本ぶんの隙間が出るので、同じ色で縁をなぞって埋める */
    c.strokeStyle = f.color;
    c.lineWidth = 1;
    c.stroke();
  }
}

/** 足元の影。地面に落ちる楕円 */
export function drawShadow(c: CanvasRenderingContext2D, cam: Cam, at: Vec3): void {
  const bs = basisOf(cam);
  const p = project(bs, cam, at);
  if (p === null) return;
  const r = (cam.focal / p.d) * 0.34;
  c.fillStyle = "rgba(10, 40, 15, .30)";
  c.beginPath();
  c.ellipse(p.x, p.y, r, r * 0.42, 0, 0, Math.PI * 2);
  c.fill();
}

/** 画面上での大きさの目安（文字を頭上に出すときなどに使う） */
export function headTop(cam: Cam, at: Vec3): { x: number; y: number } | null {
  const bs = basisOf(cam);
  const p = project(bs, cam, { x: at.x, y: at.y, z: at.z + H_TOTAL() });
  return p === null ? null : { x: p.x, y: p.y };
}
