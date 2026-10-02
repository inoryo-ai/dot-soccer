"""どの環境でも同じビットを返す sin / cos / atan2 / exp（Python 版）。

🔴 `src/sim/detmath.ts` と**一字一句同じ手順**。片方だけ直さないこと。
   正解データ（tests/golden）を作るとき、`sim.engine` の math をこれに差し替える。
   OS の数学ライブラリは最後のビットが環境ごとに違い、試合が別物になるため。
"""

import math
import struct

PIO2_1 = 1.5707963267341256
PIO2_2 = 6.077100506303966e-11
PIO2_2T = 2.0222662487959506e-21
PIO2_3 = 2.0222662487111665e-21
PIO2_3T = 8.4784276603689e-32
INVPIO2 = 0.6366197723675814
PIO4 = 0.7853981633974483
PIO2 = 1.5707963267948966
PI = 3.141592653589793
PI_LO = 1.2246467991473532e-16

S1 = -1.66666666666666324348e-01
S2 = 8.33333333332248946124e-03
S3 = -1.98412698298579493134e-04
S4 = 2.75573137070700676789e-06
S5 = -2.50507602534068634195e-08
S6 = 1.58969099521155010221e-10
C1 = 4.16666666666666019037e-02
C2 = -1.38888888888741095749e-03
C3 = 2.48015872894767294178e-05
C4 = -2.75573143513906633035e-07
C5 = 2.08757232129817482790e-09
C6 = -1.13596475577881948265e-11

ATAN_HI = (0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966)
ATAN_LO = (2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17,
           6.123233995736766e-17)
AT0 = 3.33333333333329318027e-01
AT1 = -1.99999999998764832476e-01
AT2 = 1.42857142725034663711e-01
AT3 = -1.11111104054623557880e-01
AT4 = 9.09088713343650656196e-02
AT5 = -7.69187620504482999495e-02
AT6 = 6.66107313738753120669e-02
AT7 = -5.83357013379057348645e-02
AT8 = 4.97687799461593236017e-02
AT9 = -3.65315727442169155270e-02
AT10 = 1.62858201153657823623e-02

LN2HI = 0.6931471803691238
LN2LO = 1.9082149292705877e-10
INVLN2 = 1.4426950408889634
P1 = 1.66666666666666019037e-01
P2 = -2.77777777770155933842e-03
P3 = 6.61375632143793436117e-05
P4 = -1.65339022054652515390e-06
P5 = 4.13813679705723846039e-08

REDUCE_LIMIT = 823549.6


def _pow2(k):
    if k > 1023:
        return _pow2(1023) * _pow2(k - 1023)
    if k < -1022:
        return _pow2(-1022) * _pow2(k + 1022)
    return struct.unpack(">d", struct.pack(">Q", (k + 1023) << 52))[0]


def _exponent_of(x):
    bits = struct.unpack(">Q", struct.pack(">d", x))[0]
    return ((bits >> 52) & 0x7ff) - 1023


def _rem_pio2(x):
    t = abs(x)
    if t <= PIO4:
        return 0, x, 0.0
    if t > REDUCE_LIMIT:
        raise ValueError(f"角度が大きすぎる（{x}）")
    n = math.floor(t * INVPIO2 + 0.5)
    r = t - n * PIO2_1
    w = n * PIO2_2
    r1 = r
    r = r1 - w
    w = n * PIO2_2T - ((r1 - r) - w)
    r2 = r
    w = n * PIO2_3
    r = r2 - w
    w = n * PIO2_3T - ((r2 - r) - w)
    y0 = r - w
    y1 = (r - y0) - w
    if x < 0:
        return -n, -y0, -y1
    return n, y0, y1


def _kernel_sin(x, y):
    z = x * x
    w = z * z
    r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6)
    v = z * x
    return x - ((z * (0.5 * y - v * r) - y) - v * S1)


def _kernel_cos(x, y):
    z = x * x
    w = z * z
    r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6))
    hz = 0.5 * z
    v = 1.0 - hz
    return v + (((1.0 - v) - hz) + (z * r - x * y))


def sin(x):
    if not math.isfinite(x):
        return math.nan
    n, y0, y1 = _rem_pio2(x)
    q = n % 4
    if q == 0:
        return _kernel_sin(y0, y1)
    if q == 1:
        return _kernel_cos(y0, y1)
    if q == 2:
        return -_kernel_sin(y0, y1)
    return -_kernel_cos(y0, y1)


def cos(x):
    if not math.isfinite(x):
        return math.nan
    n, y0, y1 = _rem_pio2(x)
    q = n % 4
    if q == 0:
        return _kernel_cos(y0, y1)
    if q == 1:
        return -_kernel_sin(y0, y1)
    if q == 2:
        return -_kernel_cos(y0, y1)
    return _kernel_sin(y0, y1)


def atan(x):
    if math.isnan(x):
        return math.nan
    ax = abs(x)
    if ax >= 7.378697629483821e19:
        return ATAN_HI[3] + ATAN_LO[3] if x > 0 else -(ATAN_HI[3] + ATAN_LO[3])
    if ax < 0.4375:
        if ax < 7.450580596923828e-9:
            return x
        idx = -1
        v = x
    elif ax < 0.6875:
        idx = 0
        v = (2.0 * ax - 1.0) / (2.0 + ax)
    elif ax < 1.1875:
        idx = 1
        v = (ax - 1.0) / (ax + 1.0)
    elif ax < 2.4375:
        idx = 2
        v = (ax - 1.5) / (1.0 + 1.5 * ax)
    else:
        idx = 3
        v = -1.0 / ax
    z = v * v
    w = z * z
    s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))))
    s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))))
    if idx < 0:
        return v - v * (s1 + s2)
    r = ATAN_HI[idx] - ((v * (s1 + s2) - ATAN_LO[idx]) - v)
    return -r if x < 0 else r


def atan2(y, x):
    if math.isnan(x) or math.isnan(y):
        return math.nan
    if x == 1.0:
        return atan(y)
    y_neg = math.copysign(1.0, y) < 0
    x_neg = math.copysign(1.0, x) < 0
    if y == 0:
        if not x_neg:
            return y
        return -PI if y_neg else PI
    if x == 0:
        return -PIO2 if y_neg else PIO2
    if not (math.isfinite(x) and math.isfinite(y)):
        return math.atan2(y, x)
    k = _exponent_of(abs(y)) - _exponent_of(abs(x))
    x_pos = not x_neg
    if k > 60:
        z = PIO2 + 0.5 * PI_LO
        x_pos = True
    elif x_neg and k < -60:
        z = 0.0
    else:
        z = atan(abs(y / x))
    if x_pos:
        return z if not y_neg else -z
    return PI - (z - PI_LO) if not y_neg else (z - PI_LO) - PI


def exp(x):
    if math.isnan(x):
        return math.nan
    if x > 709.782712893384:
        return math.inf
    if x < -745.1332191019411:
        return 0.0
    ax = abs(x)
    if ax < 3.725290298461914e-9:
        return 1.0 + x
    k = 0
    hi = x
    lo = 0.0
    r = x
    if ax > 0.34657359027997264:
        k = math.trunc(INVLN2 * x + (-0.5 if x < 0 else 0.5))
        hi = x - k * LN2HI
        lo = k * LN2LO
        r = hi - lo
    t = r * r
    c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
    if k == 0:
        return 1.0 - ((r * c) / (c - 2.0) - r)
    y = 1.0 - ((lo - (r * c) / (2.0 - c)) - hi)
    return y * _pow2(k)


class DeterministicMath:
    """`sim.engine.math` の代わりに差し込む名前空間。"""

    pi = math.pi
    tau = math.tau
    hypot = staticmethod(math.hypot)     # CPython の hypot は OS に依らない（平方根以外は四則演算）
    sin = staticmethod(sin)
    cos = staticmethod(cos)
    atan2 = staticmethod(atan2)
    exp = staticmethod(exp)
    floor = staticmethod(math.floor)
    copysign = staticmethod(math.copysign)
