#!/usr/bin/env python3
"""Draws the paper's figures into paper/figures/.

Each figure is saved twice, as a PDF for the LaTeX build and as a 300-dpi PNG
for the Word version. The files are named by content:

    carryover            Section 3.1, Simple COLA's wait for one invented team
    nba-comparison       Section 6.5, the simulated leagues beside the NBA
    real-standings       Section 6.5, the two help measures on real standings
    reward-by-position   Section 7.1, the reward for losing by starting position
    longest-wait         Section 7.2, the longest wait in each league
    next-series-win      Section 7.3, the wait for the next series win in each league
    mechanism-map        Section 8.1, the ten mechanisms on the reward for losing
                         and the longest wait
    draft-2026           Section 8.2, the 2026 draft under each mechanism

The carryover figure shows Simple COLA's rule on one invented team. Its waits
follow from the rule in Section 3 and the list of seasons below. Every other
figure takes its values from design_check.js, results_check.js and
draft2026_check.js, which this script runs with --json, so each value is the
one those scripts print.

Needs Python 3 with matplotlib, and Node.js for the three scripts. The text is
set in the paper's font, Caladea, when it is installed or when --font-dir names
a folder holding its files, and in DejaVu Serif otherwise.

Usage: python3 make_figures.py [--font-dir DIR] [--data DIR]

--data DIR reads design.json, results.json and draft.json from DIR, written
earlier by the three scripts with --json, in place of running them again.
"""

import argparse
import collections
import json
import math
import pathlib
import statistics
import subprocess
import sys
import tempfile
import textwrap
from concurrent.futures import ThreadPoolExecutor

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager, transforms  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent.parent / "paper" / "figures"

# The page's text width, 8.5 inches less two 1-inch margins, so each figure
# prints at its true size and its text matches the captions.
WIDTH = 6.5

# One color per mechanism the text follows, the same in every figure. The three
# are the first slots of a palette checked for separation under color blindness
# (worst pair 9.2 on the OKLab scale, against a target of 8). Every other
# mechanism is gray. Each mechanism also keeps its own marker shape, so the
# figures read in grayscale.
COLOR = {"nba": "#eb6834", "t321": "#1baf7a", "simplerule": "#2a78d6"}
MARKER = {"nba": "o", "t321": "s", "simplerule": "D"}
OTHER = "#a8a7a1"
INK = "#1d1d1b"
INK_2 = "#52514e"
GRID = "#e4e3de"
MINUS = "−"


def signed(x, digits):
	"""A number with its sign, as the paper's tables print it."""
	if abs(x) < 0.5 * 10**-digits:
		return f"{0:.{digits}f}"
	return ("+" if x > 0 else MINUS) + f"{abs(x):.{digits}f}"


def plain(x, digits):
	return (MINUS if x < 0 else "") + f"{abs(x):.{digits}f}"


def set_style(font_dir):
	if font_dir:
		for f in sorted(pathlib.Path(font_dir).iterdir()):
			if f.is_file():
				try:
					font_manager.fontManager.addfont(str(f))
				except (RuntimeError, OSError, ValueError):
					pass
	have = {f.name for f in font_manager.fontManager.ttflist}
	family = "Caladea" if "Caladea" in have else "DejaVu Serif"
	plt.rcParams.update(
		{
			"font.family": family,
			"mathtext.fontset": "custom",
			"mathtext.rm": family,
			"mathtext.it": f"{family}:italic",
			"mathtext.bf": f"{family}:bold",
			"font.size": 9,
			"axes.labelsize": 9,
			"axes.titlesize": 9,
			"xtick.labelsize": 8.5,
			"ytick.labelsize": 8.5,
			"legend.fontsize": 8.5,
			"text.color": INK,
			"axes.labelcolor": INK,
			"axes.edgecolor": INK_2,
			"xtick.color": INK_2,
			"ytick.color": INK_2,
			"xtick.labelcolor": INK,
			"ytick.labelcolor": INK,
			"axes.linewidth": 0.6,
			"xtick.major.width": 0.6,
			"ytick.major.width": 0.6,
			"xtick.major.size": 3,
			"ytick.major.size": 3,
			"axes.spines.top": False,
			"axes.spines.right": False,
			"axes.unicode_minus": True,
			"pdf.fonttype": 42,
			"savefig.dpi": 300,
		}
	)
	return family


def save(fig, name):
	OUT.mkdir(parents=True, exist_ok=True)
	# No creation date and no software stamp, so a rerun writes the same files.
	fig.savefig(OUT / f"{name}.pdf", metadata={"CreationDate": None, "Producer": None, "Creator": None})
	fig.savefig(OUT / f"{name}.png", dpi=300, metadata={"Software": None})
	plt.close(fig)
	print(f"wrote paper/figures/{name}.pdf and .png")


SCRIPTS = {"design": "design_check.js", "results": "results_check.js", "draft": "draft2026_check.js"}


def load_data(data_dir):
	"""The JSON each script writes with --json, keyed as in SCRIPTS."""
	if data_dir:
		d = pathlib.Path(data_dir)
		return {key: json.loads((d / f"{key}.json").read_text()) for key in SCRIPTS}
	with tempfile.TemporaryDirectory() as tmp:
		tmp = pathlib.Path(tmp)
		jobs = [["node", script, "--json", str(tmp / f"{key}.json")] for key, script in SCRIPTS.items()]
		with ThreadPoolExecutor(len(jobs)) as pool:
			list(pool.map(lambda cmd: subprocess.run(cmd, cwd=HERE, check=True, stdout=subprocess.DEVNULL), jobs))
		return {key: json.loads((tmp / f"{key}.json").read_text()) for key in SCRIPTS}


# ---------------------------------------------------------------------------
# Section 3.1: Simple COLA's wait for one invented team
# ---------------------------------------------------------------------------

# Each season: how the team's playoffs ended, and whether it received a
# top-three pick in that season's draft.
SEASONS = [
	("missed", False),
	("missed", False),
	("missed", False),
	("missed", False),
	("missed", True),
	("first", False),
	("first", False),
	("series", False),
	("missed", False),
	("missed", False),
]
RESULT = {"missed": "Missed the\nplayoffs", "first": "Lost in the\nfirst round", "series": "Won a\nseries"}


def fig_carryover():
	# The rule of Section 3: when the playoffs end, a series winner goes back
	# to zero and every other team adds one season; after the draft, the teams
	# with the first three picks go back to zero.
	waits, after = [], 0
	for result, top_three in SEASONS:
		at_draft = 0 if result == "series" else after + 1
		waits.append(at_draft)
		after = 0 if (top_three or result == "series") else at_draft
	n = len(SEASONS)
	x = list(range(1, n + 1))

	fig, ax = plt.subplots(figsize=(WIDTH, 2.25))
	fig.subplots_adjust(left=0.13, right=0.99, top=0.97, bottom=0.30)
	ax.bar(x, waits, width=0.58, color=COLOR["simplerule"], zorder=2)
	for xi, w in zip(x, waits):
		ax.text(xi, w + 0.12, str(w), ha="center", va="bottom", fontsize=9, color=INK)
	ax.set_xlim(0.4, n + 0.6)
	ax.set_ylim(0, 6.3)
	ax.spines["left"].set_visible(False)
	ax.set_yticks([])
	ax.set_xticks(x, [str(s) for s in x])
	ax.tick_params(axis="x", length=0, pad=4)

	# A small table under the bars: the season, then how its playoffs ended.
	under = transforms.blended_transform_factory(ax.transData, ax.transAxes)
	left = transforms.blended_transform_factory(fig.transFigure, ax.transAxes)
	ax.text(0.115, -0.06, "Season", transform=left, ha="right", va="top", fontsize=8.5, color=INK_2)
	ax.text(0.115, -0.2, "Playoffs", transform=left, ha="right", va="top", fontsize=8.5, color=INK_2)
	for xi, (result, _) in zip(x, SEASONS):
		ax.text(xi, -0.2, RESULT[result], transform=under, ha="center", va="top", fontsize=7.5, color=INK, linespacing=1.1)
	ax.text(0.115, 0.5, "Wait at\nthe draft", transform=left, ha="right", va="center", fontsize=8.5, color=INK_2, linespacing=1.1)

	pick = next(i for i, (_, t) in enumerate(SEASONS) if t) + 1
	ax.annotate(
		"Top-three pick, so the wait\nreturns to 0 after the draft",
		xy=(pick + 0.18, waits[pick - 1] - 0.15),
		xytext=(pick + 0.75, 5.05),
		fontsize=8,
		color=INK,
		va="center",
		arrowprops=dict(arrowstyle="-|>", color=INK_2, lw=0.7, shrinkA=2, shrinkB=1, mutation_scale=7),
	)
	won = next(i for i, (r, _) in enumerate(SEASONS) if r == "series") + 1
	ax.annotate(
		"Won a series, so the\nwait returns to 0",
		xy=(won, 0.62),
		xytext=(won, 3.35),
		fontsize=8,
		color=INK,
		ha="center",
		va="center",
		arrowprops=dict(arrowstyle="-|>", color=INK_2, lw=0.7, shrinkA=2, shrinkB=1, mutation_scale=7),
	)
	save(fig, "carryover")


# ---------------------------------------------------------------------------
# Section 6.5: the reward for losing and the help for a longer wait on real standings
# ---------------------------------------------------------------------------

# design_check.js part 3 lists its four rows in this order.
REAL_ROWS = [("R", "nba", "Old lottery"), ("R", "t321", "3-2-1"), ("R", "simplerule", "Simple COLA"), ("H", "simplerule", "Simple COLA")]


def fig_real_standings(design):
	rows = design["realStandings"]
	assert [r["tag"] for r in rows] == [t for _, t, _ in REAL_ROWS], "design_check.js changed its rows"
	n_seasons = rows[0]["real"]["seasons"]

	fig = plt.figure(figsize=(WIDTH, 2.55))
	gs = fig.add_gridspec(2, 1, height_ratios=[3, 1], left=0.17, right=0.585, top=0.86, bottom=0.27, hspace=0.95)
	panels = [fig.add_subplot(gs[0]), fig.add_subplot(gs[1])]
	groups = {"R": (panels[0], [r for r, (m, _, _) in zip(rows, REAL_ROWS) if m == "R"], [n for m, _, n in REAL_ROWS if m == "R"]),
		  "H": (panels[1], [r for r, (m, _, _) in zip(rows, REAL_ROWS) if m == "H"], [n for m, _, n in REAL_ROWS if m == "H"])}
	titles = {"R": "Reward for losing, $R$", "H": "Help for a longer wait, $H$"}
	digits = {"R": 2, "H": 1}
	limits = {"R": (-1.3, 1.6), "H": (5.0, 7.0)}

	# Two columns of exact values to the right of the plots.
	col_real, col_sim = 0.845, 0.975
	fig.text(col_real, 0.935, "Real standings:\naverage (95% interval)", ha="right", va="top", fontsize=8, color=INK_2, linespacing=1.1)
	fig.text(col_sim, 0.935, "Simulated\nleagues", ha="right", va="top", fontsize=8, color=INK_2, linespacing=1.1)

	for key, (ax, data, names) in groups.items():
		k = len(data)
		ys = list(range(k - 1, -1, -1))
		for y, r, tag in zip(ys, data, [t for m, t, _ in REAL_ROWS if m == key]):
			c = COLOR[tag]
			real = r["real"]
			ax.plot([real["lo"], real["hi"]], [y + 0.14] * 2, color=c, lw=2.2, solid_capstyle="butt", zorder=3)
			ax.plot([real["mean"]], [y + 0.14], marker="o", ms=5.5, color=c, zorder=4)
			ax.plot([r["sim"]], [y - 0.14], marker="D", ms=5, mfc="white", mec=c, mew=1.3, ls="none", zorder=4)
			at = transforms.blended_transform_factory(fig.transFigure, ax.transData)
			d = digits[key]
			fmt = signed if key == "R" else plain
			ax.text(col_real, y, f"{fmt(real['mean'], d)} ({plain(real['lo'], d)} to {plain(real['hi'], d)})", transform=at, ha="right", va="center", fontsize=8.5)
			ax.text(col_sim, y, fmt(r["sim"], d), transform=at, ha="right", va="center", fontsize=8.5)
		ax.set_yticks(ys, names)
		ax.tick_params(axis="y", length=0, pad=6)
		ax.set_ylim(-0.6, k - 0.4)
		ax.set_xlim(*limits[key])
		ax.xaxis.grid(True, color=GRID, lw=0.5, zorder=0)
		ax.set_axisbelow(True)
		ax.spines["left"].set_visible(False)
		ax.set_title(titles[key], loc="left", fontsize=9, pad=4, color=INK)
		if key == "R":
			ax.axvline(0, color=INK_2, lw=0.8, ls=(0, (2, 2)), zorder=1)
	panels[1].set_xlabel("Draft places", labelpad=3)

	handles = [
		Line2D([0], [0], color=INK_2, lw=2.2, marker="o", ms=5.5, label=f"Real NBA standings, {n_seasons} seasons: average and 95% interval"),
		Line2D([0], [0], ls="none", marker="D", ms=5, mfc="white", mec=INK_2, mew=1.3, label="Simulated leagues: average"),
	]
	fig.legend(handles=handles, loc="lower left", bbox_to_anchor=(0.005, 0.0), ncol=2, frameon=False, handlelength=2.2, columnspacing=1.6)
	save(fig, "real-standings")


# ---------------------------------------------------------------------------
# Section 7.1: the reward for losing from each starting position
# ---------------------------------------------------------------------------


def ordinal(n):
	return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def fig_reward_by_position(results):
	pos = results["positions"]
	fig, ax = plt.subplots(figsize=(WIDTH, 2.7))
	fig.subplots_adjust(left=0.1, right=0.99, top=0.97, bottom=0.18)
	ax.axhline(0, color=INK_2, lw=0.8, zorder=2)
	for tag, label in [("nba", "Old lottery"), ("t321", "3-2-1"), ("simplerule", "Simple COLA")]:
		y = results["reward"][tag]
		ax.plot(pos, y, color=COLOR[tag], lw=1.6, marker=MARKER[tag], ms=4.6, mec="white", mew=0.6, zorder=3)
		ax.text(pos[-1] + 0.3, y[-1], label, ha="left", va="center", fontsize=8.5, color=INK)
	ax.set_xlim(pos[0] - 0.5, pos[-1] + 1.9)
	ax.set_ylim(-4.6, 11.2)
	ax.set_xticks(pos, [ordinal(p) for p in pos])
	ax.set_yticks(range(-4, 11, 2))
	ax.yaxis.grid(True, color=GRID, lw=0.5, zorder=0)
	ax.set_axisbelow(True)
	ax.set_xlabel("Starting position, counted from the worst record among the 14 teams that missed the playoffs", labelpad=4)
	ax.set_ylabel("Reward for losing, $R$ (draft places)", labelpad=4)
	ax.text(pos[0] - 0.35, 10.9, "Above 0, dropping to the worst record gains a team places", ha="left", va="top", fontsize=8, color=INK_2, style="italic")
	ax.text(pos[0] - 0.35, -4.35, "Below 0, it costs the team places", ha="left", va="bottom", fontsize=8, color=INK_2, style="italic")
	save(fig, "reward-by-position")


# ---------------------------------------------------------------------------
# Section 7.2: the longest wait in each league
# ---------------------------------------------------------------------------


def dot_offsets(count, dx=0.27, dy=0.17, max_rows=5):
	"""Places `count` dots that share one value in a small centered grid."""
	cols = max(1, math.ceil(count / max_rows))
	rows = math.ceil(count / cols)
	out = []
	for k in range(count):
		r, c = divmod(k, cols)
		in_row = min(cols, count - r * cols)
		out.append(((c - (in_row - 1) / 2) * dx, ((rows - 1) / 2 - r) * dy))
	return out


def fig_longest_wait(results):
	mechs = results["mechanisms"]
	waits = results["longestWait"]
	n = len(mechs)
	# 3.0 inches held nine rows; each row keeps that height.
	fig, ax = plt.subplots(figsize=(WIDTH, 3.0 * (n + 0.25) / 9.25))
	fig.subplots_adjust(left=0.2, right=0.9, top=0.93, bottom=0.155)
	at = transforms.blended_transform_factory(ax.transAxes, ax.transData)
	for i, m in enumerate(mechs):
		y = n - 1 - i
		values = waits[m["tag"]]
		color = COLOR.get(m["tag"], OTHER)
		for v, count in sorted(collections.Counter(values).items()):
			for ox, oy in dot_offsets(count):
				ax.plot(v + ox, y + oy, marker="o", ms=3.1, color=color, mec="white", mew=0.3, ls="none", zorder=3)
		avg = sum(values) / len(values)
		ax.plot([avg, avg], [y - 0.42, y + 0.42], color=INK, lw=1.0, zorder=4)
		ax.text(1.045, y, f"{avg:.1f}", transform=at, ha="right", va="center", fontsize=8.5)
	ax.text(1.045, n - 0.35, "Average", transform=at, ha="right", va="bottom", fontsize=8, color=INK_2)
	# The three lotteries sit above the seven COLA mechanisms.
	ax.axhline(n - 3.5, color=GRID, lw=0.9, zorder=1)
	ax.axvline(25, color=INK_2, lw=0.7, ls=(0, (2, 2)), zorder=1)
	# Placed between the Countdown and Simple COLA rows, whose dots stop well short of 25.
	ax.text(24.7, 2.5, "Every league\nlasts 25 seasons", ha="right", va="center", fontsize=7.5, color=INK_2, linespacing=1.05)
	ax.set_yticks([n - 1 - i for i in range(n)], [m["name"] for m in mechs])
	ax.tick_params(axis="y", length=0, pad=6)
	ax.spines["left"].set_visible(False)
	ax.set_xlim(0, 26.5)
	ax.set_ylim(-0.6, n - 0.35)
	ax.set_xticks(range(0, 26, 5))
	ax.xaxis.grid(True, color=GRID, lw=0.5, zorder=0)
	ax.set_axisbelow(True)
	ax.set_xlabel("Longest wait in a league, in seasons, with one dot per league", labelpad=4)
	save(fig, "longest-wait")


# ---------------------------------------------------------------------------
# Rows of dots, one per league, for values that rarely tie
# ---------------------------------------------------------------------------


def swarm(values, gap, step, max_slots=4):
	"""Vertical offsets for one row of dots. Taken in order of value, each dot
	takes the free slot nearest the row's center line, where a slot is free if
	no dot already in it lies closer than `gap` along the row."""
	placed = []
	out = [0.0] * len(values)
	for i in sorted(range(len(values)), key=lambda j: values[j]):
		x = values[i]
		for k in range(2 * max_slots + 1):
			y = 0.0 if k == 0 else ((k + 1) // 2) * step * (1 if k % 2 else -1)
			if all(abs(x - px) >= gap or abs(y - py) > 1e-9 for px, py in placed):
				break
		placed.append((x, y))
		out[i] = y
	return out


# ---------------------------------------------------------------------------
# Section 6.5: the simulated leagues beside the NBA
# ---------------------------------------------------------------------------

# The seven statistics of Section 6.5, worded and rounded as the paper gives
# them: a number of decimals, a percentage, or whole seasons.
NBA_ROWS = [
	("spread", "Spread of win percentage within a season (standard deviation)", "3"),
	("lag1", "Correlation between a team's win percentage and its own a season earlier", "2"),
	("lag3", "The same correlation, three seasons apart", "2"),
	("again", "Playoff teams that reached the playoffs again the next season", "%"),
	("back", "Wait to return to the playoffs, in seasons", "2"),
	("win", "Wait for the next series win, in seasons", "2"),
	("longest", "Longest wait for a series win or a top-three pick, in seasons", "whole"),
]


def nba_strings(kind, nba, values):
	"""The NBA's value, and the leagues' average with the lowest and highest."""
	avg, lo, hi = statistics.mean(values), min(values), max(values)
	if kind == "%":
		pct = lambda x: f"{100 * x:.0f}%"  # noqa: E731
		return pct(nba), f"{pct(avg)} ({pct(lo)} to {pct(hi)})"
	if kind == "whole":
		return f"{nba:.0f}", f"{avg:.1f} ({lo:.0f} to {hi:.0f})"
	d = int(kind)
	return f"{nba:.{d}f}", f"{avg:.{d}f} ({lo:.{d}f} to {hi:.{d}f})"


def fig_nba_comparison(design):
	c = design["nbaComparison"]
	n = len(NBA_ROWS)
	height = 3.45
	fig = plt.figure(figsize=(WIDTH, height))
	top, bottom = 0.87, 0.1
	row = (top - bottom) / n
	strip_left, strip_width = 0.385, 0.25
	col_nba, col_sim = 0.725, 0.995
	fig.text(col_nba, 0.975, "NBA", ha="right", va="top", fontsize=8, color=INK_2)
	fig.text(col_sim, 0.975, "Simulated leagues:\naverage (lowest to highest)", ha="right", va="top", fontsize=8, color=INK_2, linespacing=1.1)
	dot = 3.4  # points
	for i, (key, label, kind) in enumerate(NBA_ROWS):
		y0 = top - (i + 1) * row
		ax = fig.add_axes([strip_left, y0 + 0.1 * row, strip_width, 0.8 * row])
		values = [league[key] for league in c["leagues"]]
		nba = c["nba"][key]
		lo, hi = min(values + [nba]), max(values + [nba])
		pad = 0.08 * (hi - lo)
		ax.set_xlim(lo - pad, hi + pad)
		ax.set_ylim(-1, 1)
		gap = dot / (strip_width * WIDTH * 72) * (hi - lo + 2 * pad)
		step = dot / (0.8 * row * height * 72) * 2
		ax.axhline(0, color=GRID, lw=0.6, zorder=1)
		ax.plot(values, swarm(values, gap, step), marker="o", ms=dot, color=COLOR["nba"], mec="white", mew=0.3, ls="none", zorder=3)
		ax.plot([nba], [0], marker="D", ms=6, color=INK, mec="white", mew=0.6, ls="none", zorder=4)
		ax.axis("off")
		middle = y0 + row / 2
		fig.text(0.005, middle, textwrap.fill(label, 42, break_on_hyphens=False), ha="left", va="center", fontsize=8.5, linespacing=1.1)
		shown_nba, shown_sim = nba_strings(kind, nba, values)
		fig.text(col_nba, middle, shown_nba, ha="right", va="center", fontsize=8.5)
		fig.text(col_sim, middle, shown_sim, ha="right", va="center", fontsize=8.5)
	handles = [
		Line2D([0], [0], ls="none", marker="o", ms=dot + 1, color=COLOR["nba"], label="One simulated league, run under the old lottery"),
		Line2D([0], [0], ls="none", marker="D", ms=6, color=INK, label=f"The NBA, {c['first']} to {c['last']}"),
	]
	fig.legend(handles=handles, loc="lower left", bbox_to_anchor=(0.0, 0.0), ncol=2, frameon=False, handletextpad=0.4, columnspacing=1.8)
	save(fig, "nba-comparison")


# ---------------------------------------------------------------------------
# Section 7.3: the wait for the next series win in each league
# ---------------------------------------------------------------------------


def fig_next_series_win(results, design):
	mechs = results["mechanisms"]
	waits = results["nextSeriesWin"]
	nba = design["nbaComparison"]["nba"]["win"]
	n = len(mechs)
	# 3.0 inches held nine rows; each row keeps that height.
	height, top, bottom = 3.0 * (n + 0.25) / 9.25, 0.92, 0.155
	fig, ax = plt.subplots(figsize=(WIDTH, height))
	fig.subplots_adjust(left=0.2, right=0.9, top=top, bottom=bottom)
	at = transforms.blended_transform_factory(ax.transAxes, ax.transData)
	lo = min(min(v) for v in waits.values())
	hi = max(max(v) for v in waits.values())
	x0, x1 = math.floor(lo * 2) / 2 - 0.1, math.ceil(hi * 2) / 2 + 0.1
	ax.set_xlim(x0, x1)
	ax.set_ylim(-0.6, n - 0.35)
	dot = 3.1  # points
	gap = dot / (0.7 * WIDTH * 72) * (x1 - x0)
	step = dot / ((top - bottom) * height * 72 / (n + 0.25))
	for i, m in enumerate(mechs):
		y = n - 1 - i
		values = waits[m["tag"]]
		offsets = swarm(values, gap, step, max_slots=5)
		ax.plot(values, [y + o for o in offsets], marker="o", ms=dot, color=COLOR.get(m["tag"], OTHER), mec="white", mew=0.3, ls="none", zorder=3)
		avg = statistics.mean(values)
		ax.plot([avg, avg], [y - 0.42, y + 0.42], color=INK, lw=1.0, zorder=4)
		ax.text(1.045, y, f"{avg:.2f}", transform=at, ha="right", va="center", fontsize=8.5)
	ax.text(1.045, n - 0.35, "Average", transform=at, ha="right", va="bottom", fontsize=8, color=INK_2)
	# The three lotteries sit above the seven COLA mechanisms.
	ax.axhline(n - 3.5, color=GRID, lw=0.9, zorder=1)
	ax.axvline(nba, color=INK_2, lw=0.7, ls=(0, (2, 2)), zorder=1)
	ax.text(nba, n - 0.35, f"NBA, {nba:.2f}", ha="center", va="bottom", fontsize=7.5, color=INK_2)
	ax.set_yticks([n - 1 - i for i in range(n)], [m["name"] for m in mechs])
	ax.tick_params(axis="y", length=0, pad=6)
	ax.spines["left"].set_visible(False)
	ax.xaxis.grid(True, color=GRID, lw=0.5, zorder=0)
	ax.set_axisbelow(True)
	ax.set_xlabel("Wait for the next series win in a league, in seasons, with one dot per league", labelpad=4)
	save(fig, "next-series-win")


# ---------------------------------------------------------------------------
# Section 8.1: the ten mechanisms on the reward for losing and the longest wait
# ---------------------------------------------------------------------------

# Where each name sits beside its dot: offset in points, and alignment.
MAP_LABELS = {
	"nba": (7, 0, "left"),
	"uniform": (0, -10, "center"),
	"t321": (-7, 0, "right"),
	"classic": (7, 0, "left"),
	"waitlist": (7, 0, "left"),
	"full": (-7, 0, "right"),
	"simplerule": (-7, 0, "right"),
	"countdown": (7, 0, "left"),
	"beckett": (-7, 0, "right"),
	"capped": (0, -10, "center"),
}


def fig_mechanism_map(results):
	mechs = results["mechanisms"]
	at = results["positions"].index(5)  # the standard starting point of Section 6.3
	fig, ax = plt.subplots(figsize=(WIDTH, 3.0))
	fig.subplots_adjust(left=0.09, right=0.98, top=0.95, bottom=0.16)
	ax.axvline(0, color=INK_2, lw=0.8, ls=(0, (2, 2)), zorder=1)
	for m in mechs:
		tag = m["tag"]
		x = results["reward"][tag][at]
		y = statistics.mean(results["longestWait"][tag])
		ax.plot([x], [y], marker=MARKER.get(tag, "o"), ms=7, color=COLOR.get(tag, OTHER), mec="white", mew=0.8, ls="none", zorder=3)
		dx, dy, ha = MAP_LABELS[tag]
		name = m["name"] + (", no drawing" if tag == "simplerule" else "")
		# A white backing keeps the dashed zero line from running through a name.
		ax.annotate(name, (x, y), xytext=(dx, dy), textcoords="offset points", ha=ha, va="center", fontsize=8.5, color=INK, bbox=dict(fc="white", ec="none", pad=0.6), zorder=4)
	ax.set_xlim(-5.4, 3.6)
	ax.set_ylim(0, 18.5)
	ax.set_yticks(range(0, 19, 3))
	ax.yaxis.grid(True, color=GRID, lw=0.5, zorder=0)
	ax.set_axisbelow(True)
	ax.text(-0.15, 18.3, "Losing costs places", ha="right", va="top", fontsize=8, color=INK_2, style="italic")
	ax.text(0.15, 18.3, "Losing gains places", ha="left", va="top", fontsize=8, color=INK_2, style="italic")
	ax.set_xlabel("Reward for losing from the fifth-worst record, $R$ (draft places)", labelpad=4)
	ax.set_ylabel("Longest wait, $L$ (seasons)", labelpad=4)
	save(fig, "mechanism-map")


# ---------------------------------------------------------------------------
# Section 8.2: the 2026 draft under each mechanism
# ---------------------------------------------------------------------------

# The columns of chances. Classic, Waitlist and Full-lottery COLA draw their
# first pick on the same tickets, so they share one column.
DRAFT_COLUMNS = [
	("old", "Old\nlottery"),
	("uniform", "Equal-odds\nlottery"),
	("t321", "3-2-1"),
	("full", "Classic,\nWaitlist and\nFull-lottery\nCOLA"),
	("countdown", "Countdown\nCOLA"),
	("beckett", "Beckett\nCOLA"),
	("capped", "Capped\nCOLA"),
]
# Shading for a chance of the first pick, from none to the largest in the figure.
SHADE = LinearSegmentedColormap.from_list("first-pick", ["#f3f7fd", "#2a78d6", "#123d73"])


def chance_text(v):
	"""A chance of the first pick as the figure prints it, in percent."""
	if v is None:
		return "–"  # outside the mechanism's pool
	if v == 0:
		return "0"  # in the pool, but barred from the first pick
	if v < 0.0005:
		return "<0.1"
	return f"{100 * v:.1f}"


def fig_draft2026(draft):
	rows = draft["rows"]
	for r in rows:  # the three ticket mechanisms must agree to share a column
		fp = r["firstPick"]
		assert fp["classic"] == fp["waitlist"] == fp["full"], r["id"]
	groups = [
		("Missed the playoffs", sorted((r for r in rows if r["missed"]), key=lambda r: (r["wins"], r["name"]))),
		("Lost in the first round", sorted((r for r in rows if not r["missed"]), key=lambda r: (r["wins"], r["name"]))),
	]
	top = max(v for r in rows for m, _ in DRAFT_COLUMNS if (v := r["firstPick"][m]) is not None)
	header, row_h, group_h = 0.82, 0.158, 0.2
	height = header + sum(group_h + row_h * len(g) for _, g in groups) + 0.04
	fig = plt.figure(figsize=(WIDTH, height))
	ax = fig.add_axes([0, 0, 1, 1])
	ax.set_xlim(0, WIDTH)
	ax.set_ylim(height, 0)
	ax.axis("off")
	x_wins, x_wait, left, width = 1.38, 1.73, 1.98, 0.57
	x_simple = left + width * len(DRAFT_COLUMNS) + 0.25
	small = 7.5
	ax.text(left + width * len(DRAFT_COLUMNS) / 2, 0.06, "Chance of the first pick, %", ha="center", va="top", fontsize=8, color=INK_2)
	for k, (_, label) in enumerate(DRAFT_COLUMNS):
		ax.text(left + width * (k + 0.5), header - 0.06, label, ha="center", va="bottom", fontsize=small, color=INK_2, linespacing=1.05)
	ax.text(x_wins, header - 0.06, "Wins", ha="center", va="bottom", fontsize=small, color=INK_2)
	ax.text(x_wait, header - 0.06, "Wait", ha="center", va="bottom", fontsize=small, color=INK_2)
	ax.text(x_simple, header - 0.06, "Simple\nCOLA\npick", ha="center", va="bottom", fontsize=small, color=INK_2, linespacing=1.05)
	ax.plot([0, WIDTH], [header, header], color=INK_2, lw=0.6)
	y = header
	for title, group in groups:
		ax.text(0.02, y + group_h / 2 + 0.01, title, ha="left", va="center", fontsize=small, color=INK_2, style="italic")
		y += group_h
		for r in group:
			middle = y + row_h / 2
			ax.text(0.02, middle, r["name"], ha="left", va="center", fontsize=small)
			ax.text(x_wins, middle, str(r["wins"]), ha="center", va="center", fontsize=small)
			ax.text(x_wait, middle, str(r["wait"]), ha="center", va="center", fontsize=small)
			for k, (m, _) in enumerate(DRAFT_COLUMNS):
				v = r["firstPick"][m]
				x0 = left + width * k
				if v:
					ax.add_patch(Rectangle((x0 + 0.02, y + 0.012), width - 0.04, row_h - 0.024, color=SHADE(v / top), lw=0))
				ax.text(x0 + width / 2, middle, chance_text(v), ha="center", va="center", fontsize=small, color="white" if v and v / top > 0.55 else (INK_2 if v is None else INK))
			pick = r["simplePick"]
			ax.text(x_simple, middle, "" if pick is None else f"{pick:g}", ha="center", va="center", fontsize=small, fontweight="bold" if pick is not None and pick <= 3 else "normal")
			y += row_h
	save(fig, "draft-2026")


def main():
	p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
	p.add_argument("--font-dir", help="a folder holding the Caladea font files")
	p.add_argument("--data", help="a folder holding design.json, results.json and draft.json from an earlier run")
	a = p.parse_args()
	family = set_style(a.font_dir)
	data = load_data(a.data)
	design, results, draft = data["design"], data["results"], data["draft"]
	fig_carryover()
	fig_nba_comparison(design)
	fig_real_standings(design)
	fig_reward_by_position(results)
	fig_longest_wait(results)
	fig_next_series_win(results, design)
	fig_mechanism_map(results)
	fig_draft2026(draft)
	print(f"font: {family}")


if __name__ == "__main__":
	sys.exit(main())
