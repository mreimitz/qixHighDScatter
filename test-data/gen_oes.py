"""Synthetic approach/landing data for qixHighDScatter: 1,000,000 points.

2,000 approaches x 500 samples along the track (-2200 m .. 3500 m from the
threshold). Each point gets lateral, vertical and pitch values plus a class per
axis (Core / Expanded ES / Out of OES) computed from the SAME envelopes the zone
tables draw, so the extension's zone colouring and the category columns agree.
Seeded: every run writes identical files.
"""

import os
import sys

import numpy as np
import pandas as pd

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(20260926)

N_FLIGHTS, N_SAMPLES = 2000, 500
X0, X1 = -2200.0, 3500.0

# ---------------------------------------------------------------- envelopes
def lat_core(x):  # half-width, mirrored
    return np.where(x < -300, 20 + 130 * (-300 - x) / 1900, 20.0)

def lat_exp(x):
    return np.where(x < -300, 40 + 190 * (-300 - x) / 1900, 40.0)

def v_nom(x):
    return 10 + 0.047 * np.maximum(-x, 0)

def v_core(x):
    d = np.maximum(-x, 0)
    return v_nom(x) - (5 + 0.018 * d), v_nom(x) + (5 + 0.018 * d)

def v_exp(x):
    d = np.maximum(-x, 0)
    return np.maximum(v_nom(x) - (10 + 0.035 * d), 0), v_nom(x) + (10 + 0.035 * d)

def p_core(x):
    return np.where(x < 700, -2.0, 0.0), np.where(x < 700, 3.0, 4.0)

def p_exp(x):
    return np.full_like(x, -4.0), np.where((x >= 700) & (x < 2000), 11.0, 6.0)

CLASSES = np.array(["Core", "Expanded ES", "Out of OES"])

def classify(v, core, exp):
    (cl, cu), (el, eu) = core, exp
    return np.where((v >= cl) & (v <= cu), 0, np.where((v >= el) & (v <= eu), 1, 2))

# ---------------------------------------------------------------- tracks
F, S = N_FLIGHTS, N_SAMPLES
x = np.linspace(X0, X1, S)[None, :] + rng.normal(0, 4, (F, S))
x = np.clip(np.sort(x, axis=1), X0, X1)
km = (x - X0) / 1000.0

def smooth(scale=1.0):
    """Low-frequency per-flight wander: three sinusoids + a constant offset."""
    g = rng.normal(0, 0.55, (F, 1))
    for f in (0.35, 0.8, 1.7):
        g = g + rng.normal(0, 0.28, (F, 1)) * np.sin(2 * np.pi * f * km + rng.uniform(0, 2 * np.pi, (F, 1)))
    return g * scale

def window(center, width):
    return np.exp(-0.5 * ((x - center) / width) ** 2)

# Flight profile: 0 core, 1 expanded, 2 out; and which axis deviates.
profile = rng.choice(3, F, p=[0.6, 0.32, 0.08])
dev_axis = rng.choice(3, F, p=[0.4, 0.35, 0.25])  # 0 lateral, 1 vertical, 2 pitch
sign = rng.choice([-1.0, 1.0], (F, 1))
dev_lat = ((profile > 0) & (dev_axis == 0))[:, None]
dev_ver = ((profile > 0) & (dev_axis == 1))[:, None]
dev_pit = ((profile > 0) & (dev_axis == 2))[:, None]
out = (profile == 2)[:, None]

# Lateral: a smooth fraction of the core half-width, pushed out on deviating flights.
lc, le = lat_core(x), lat_exp(x)
a = 0.9 * np.tanh(smooth())
lateral = a * lc
# Expanded deviation: an early wide sweep (the red curve converging into the funnel).
c = rng.uniform(-1900, -700, (F, 1))
w = window(c, rng.uniform(300, 800, (F, 1)))
w_lat = w
u = rng.uniform(0.25, 0.85, (F, 1))
target = np.where(out, le * 1.25 + 25, lc + u * (le - lc))
lateral = np.where(dev_lat, (1 - w) * lateral + w * sign * target, lateral)
lateral += rng.normal(0, 0.8, (F, S))

# Vertical: the glide path, a fraction of the core band around it.
lo, hi = v_core(x)
nom = v_nom(x)
b = 0.9 * np.tanh(smooth())
height = nom + b * (hi - nom)
elo, ehi = v_exp(x)
c = rng.uniform(-1800, -200, (F, 1))
w = window(c, rng.uniform(350, 900, (F, 1)))
u = rng.uniform(0.2, 0.85, (F, 1))
above = hi + u * (ehi - hi)
below = lo - u * (lo - elo)
exp_target = np.where(sign > 0, above, below)
# Out-of-OES tracks: a steeper approach flown above the expanded envelope.
steep = ehi + rng.uniform(3, 20, (F, 1)) + rng.uniform(0.004, 0.03, (F, 1)) * np.maximum(-x, 0) + 6 * np.tanh(smooth())
height = np.where(dev_ver & ~out, (1 - w) * height + w * exp_target, height)
w_out = 1 / (1 + np.exp((x + 400) / 120))  # steep until ~400 m before the threshold
height = np.where(dev_ver & out, (1 - w_out) * height + w_out * steep, height)
height = np.maximum(height + rng.normal(0, 0.6, (F, S)), 0.3)

# Pitch: about 0.5 deg on approach, rotation step to about 2.5 deg from 700 m.
step = 1 / (1 + np.exp(-(x - 720) / 25))
pitch = (0.5 + 0.7 * np.tanh(smooth(0.9))) * (1 - step) + (2.4 + 0.5 * np.tanh(smooth(0.9))) * step
c = rng.uniform(800, 1900, (F, 1))
w = window(c, rng.uniform(60, 160, (F, 1)))
spike = np.where(out, rng.uniform(12, 14, (F, 1)), rng.uniform(4.5, 7.5, (F, 1)))
pitch = np.where(dev_pit, pitch + w * spike, pitch)
pitch += rng.normal(0, 0.08, (F, S))

roll = 1.2 * np.tanh(smooth()) + np.where(dev_lat, 4 * w_lat, 0) + rng.normal(0, 0.3, (F, S))
speed0 = rng.normal(140, 6, (F, 1))
ground_speed = np.where(x < 300, speed0 - 0.002 * (x - X0), (speed0 - 0.002 * (300 - X0)) * np.exp(-(x - 300) / 2500))
ground_speed += rng.normal(0, 0.8, (F, S))
wind = np.repeat(np.round(rng.gamma(2.2, 5, (F, 1)), 1), S, axis=1)

# ---------------------------------------------------------------- classes
lat_cls = classify(lateral, (-lc, lc), (-le, le))
ver_cls = classify(height, v_core(x), v_exp(x))
pit_cls = classify(pitch, p_core(x), p_exp(x))
ooe = np.maximum(np.maximum(lat_cls, ver_cls), pit_cls)
flight_ooe = np.repeat(ooe.max(axis=1, keepdims=True), S, axis=1)

# ---------------------------------------------------------------- attributes
ac = np.array(["A320", "A321", "B738", "B38M", "E190", "A350", "B77W", "A388"])
rw = np.array(["09L", "09R", "27L", "27R"])
al = np.array(["Northwind", "Blue Heron", "Aurora Air", "Coastline", "Meridian"])
days = pd.date_range("2026-06-01", "2026-08-31", freq="D").strftime("%Y-%m-%d").to_numpy()
per = lambda arr, p=None: np.repeat(rng.choice(arr, (F, 1), p=p), S, axis=1)
flight = np.repeat(np.arange(1, F + 1)[:, None], S, axis=1)

df = pd.DataFrame(
    {
        "PointID": np.arange(1, F * S + 1),
        "FlightID": np.char.add("FL", np.char.zfill(flight.ravel().astype(str), 5)),
        "SampleSeq": np.tile(np.arange(1, S + 1), F),
        "AlongTrack_m": x.ravel().round(1),
        "CrossTrack_m": lateral.ravel().round(2),
        "Height_m": height.ravel().round(2),
        "Pitch_deg": pitch.ravel().round(2),
        "Roll_deg": roll.ravel().round(2),
        "GroundSpeed_kt": ground_speed.ravel().round(1),
        "Wind_kt": wind.ravel(),
        "OOE_Class": CLASSES[ooe.ravel()],
        "Flight_OOE_Class": CLASSES[flight_ooe.ravel()],
        "Lateral_Class": CLASSES[lat_cls.ravel()],
        "Vertical_Class": CLASSES[ver_cls.ravel()],
        "Pitch_Class": CLASSES[pit_cls.ravel()],
        "AircraftType": per(ac, [0.24, 0.14, 0.2, 0.1, 0.12, 0.08, 0.08, 0.04]).ravel(),
        "Runway": per(rw).ravel(),
        "Airline": per(al).ravel(),
        "FlightDate": per(days).ravel(),
    }
)
# Demo subsets: nested, whole approaches only (a subset never cuts a track), random
# flight order so each subset keeps the full mix. 1 = in the set, empty = not.
order = np.empty(F, dtype=int)
order[rng.permutation(F)] = np.arange(F)
rank = np.repeat(order, S)
for label, n in (("25k", 25_000), ("50k", 50_000), ("100k", 100_000), ("250k", 250_000), ("500k", 500_000), ("1m", 1_000_000)):
    df[f"Demo_{label}"] = pd.array(np.where(rank < n // S, 1, pd.NA), dtype="Int8")
df.to_csv(os.path.join(OUT, "OES_Approach_Points_1M.csv"), index=False)

# ---------------------------------------------------------------- zone tables
BLUE, RED = "#2f6fd6", "#d62f2f"

def env_rows(prefix, zid, label, color, upper, lower=None):
    rows = []
    for edge, pts in (("upper", upper), ("lower", lower or [])):
        for i, (px, py) in enumerate(pts, 1):
            rows.append({f"{prefix}ZoneID": zid, f"{prefix}ZoneLabel": label, f"{prefix}ZoneColor": color,
                         f"{prefix}ZoneEdge": edge, f"{prefix}ZoneSeq": i, f"{prefix}ZoneX": px, f"{prefix}ZoneY": py})
    return rows

def pts(xs, f):
    xs = np.array(xs, dtype=float)
    return list(zip(xs.tolist(), np.round(f(xs), 3).tolist()))

lat = env_rows("Lat", "L1", "Core", BLUE, pts([X0, -300, X1], lat_core)) + env_rows(
    "Lat", "L2", "Expanded ES", RED, pts([X0, -300, X1], lat_exp))
vx = [X0, 0, X1]
ver = env_rows("Vert", "V1", "Core", BLUE, pts(vx, lambda s: v_core(s)[1]), pts(vx, lambda s: v_core(s)[0])) + env_rows(
    "Vert", "V2", "Expanded ES", RED, pts(vx, lambda s: v_exp(s)[1]),
    pts(vx, lambda s: v_exp(s)[0]))
cx = [X0, 699.9, 700, X1]
ex = [X0, 699.9, 700, 1999.9, 2000, X1]
pit = env_rows("Pitch", "P1", "Core", BLUE, pts(cx, lambda s: p_core(s)[1]), pts(cx, lambda s: p_core(s)[0])) + env_rows(
    "Pitch", "P2", "Expanded ES", RED, pts(ex, lambda s: p_exp(s)[1]), pts(ex, lambda s: p_exp(s)[0]))
for name, rows in (("Lateral", lat), ("Vertical", ver), ("Pitch", pit)):
    pd.DataFrame(rows).to_csv(os.path.join(OUT, f"OES_Zones_{name}.csv"), index=False)

# ---------------------------------------------------------------- summary
print(len(df), "rows")
print(df["OOE_Class"].value_counts(normalize=True).round(3).to_dict())
for col in [c for c in df.columns if c.startswith("Demo_")]:
    print(col, int(df[col].sum()), df.loc[df[col] == 1, "OOE_Class"].value_counts(normalize=True).round(3).to_dict())
for col in ("Lateral_Class", "Vertical_Class", "Pitch_Class", "Flight_OOE_Class"):
    print(col, df[col].value_counts().to_dict())
print(df[["AlongTrack_m", "CrossTrack_m", "Height_m", "Pitch_deg", "GroundSpeed_kt", "Wind_kt"]].describe().round(2))
