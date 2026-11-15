#!/usr/bin/env python3
"""Draws Figures 1 to 4 of the paper into paper/figures/.

Each figure is saved twice, as a PDF for the LaTeX build and as a 300-dpi PNG
for the Word version.

Figure 1 shows Simple COLA's rule on one invented team. Its waits follow from
the rule in Section 3 and the list of seasons below. Figures 2 to 4 take every
value from design_check.js and results_check.js, which this script runs with
--json, so each value is the one those scripts print.

Needs Python 3 with matplotlib, and Node.js for the two scripts. The text is
set in the paper's font, Caladea, when it is installed or when --font-dir names
a folder holding its files, and in DejaVu Serif otherwise.

Usage: python3 make_figures.py [--font-dir DIR] [--data DIR]

--data DIR reads design.json and results.json from DIR, written earlier by the
two scripts with --json, in place of running them again.
"""

import argparse
import collections
import json
import math
import pathlib
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager, transforms  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

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


def load_data(data_dir):
	if data_dir:
		d = pathlib.Path(data_dir)
		return json.loads((d / "design.json").read_text()), json.loads((d / "results.json").read_text())
	with tempfile.TemporaryDirectory() as tmp:
		tmp = pathlib.Path(tmp)
		jobs = [
			["node", "design_check.js", "--json", str(tmp / "design.json")],
			["node", "results_check.js", "--json", str(tmp / "results.json")],
		]
		with ThreadPoolExecutor(len(jobs)) as pool:
			list(pool.map(lambda cmd: subprocess.run(cmd, cwd=HERE, check=True, stdout=subprocess.DEVNULL), jobs))
		return json.loads((tmp / "design.json").read_text()), json.loads((tmp / "results.json").read_text())


# ---------------------------------------------------------------------------
# Figure 1. Simple COLA's wait for one invented team
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


def figure1():
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
	save(fig, "fig1-carryover")


# ---------------------------------------------------------------------------
# Figure 2. The reward for losing and the help for a longer wait on real standings
# ---------------------------------------------------------------------------

# design_check.js part 3 lists its four rows in this order.
FIG2_ROWS = [("R", "nba", "Old lottery"), ("R", "t321", "3-2-1"), ("R", "simplerule", "Simple COLA"), ("H", "simplerule", "Simple COLA")]


def figure2(design):
	rows = design["realStandings"]
	assert [r["tag"] for r in rows] == [t for _, t, _ in FIG2_ROWS], "design_check.js changed its rows"
	n_seasons = rows[0]["real"]["seasons"]

	fig = plt.figure(figsize=(WIDTH, 2.55))
	gs = fig.add_gridspec(2, 1, height_ratios=[3, 1], left=0.17, right=0.585, top=0.86, bottom=0.27, hspace=0.95)
	panels = [fig.add_subplot(gs[0]), fig.add_subplot(gs[1])]
	groups = {"R": (panels[0], [r for r, (m, _, _) in zip(rows, FIG2_ROWS) if m == "R"], [n for m, _, n in FIG2_ROWS if m == "R"]),
		  "H": (panels[1], [r for r, (m, _, _) in zip(rows, FIG2_ROWS) if m == "H"], [n for m, _, n in FIG2_ROWS if m == "H"])}
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
		for y, r, tag in zip(ys, data, [t for m, t, _ in FIG2_ROWS if m == key]):
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
	save(fig, "fig2-real-standings")


# ---------------------------------------------------------------------------
# Figure 3. The reward for losing from each starting position
# ---------------------------------------------------------------------------


def ordinal(n):
	return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def figure3(results):
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
	save(fig, "fig3-reward-by-position")


# ---------------------------------------------------------------------------
# Figure 4. The longest wait in each league
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


def figure4(results):
	mechs = results["mechanisms"]
	waits = results["longestWait"]
	n = len(mechs)
	fig, ax = plt.subplots(figsize=(WIDTH, 3.0))
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
	# The three lotteries sit above the six COLA mechanisms.
	ax.axhline(n - 3.5, color=GRID, lw=0.9, zorder=1)
	ax.axvline(25, color=INK_2, lw=0.7, ls=(0, (2, 2)), zorder=1)
	ax.text(24.7, 0.5, "Every league\nlasts 25 seasons", ha="right", va="center", fontsize=7.5, color=INK_2, linespacing=1.05)
	ax.set_yticks([n - 1 - i for i in range(n)], [m["name"] for m in mechs])
	ax.tick_params(axis="y", length=0, pad=6)
	ax.spines["left"].set_visible(False)
	ax.set_xlim(0, 26.5)
	ax.set_ylim(-0.6, n - 0.35)
	ax.set_xticks(range(0, 26, 5))
	ax.xaxis.grid(True, color=GRID, lw=0.5, zorder=0)
	ax.set_axisbelow(True)
	ax.set_xlabel("Longest wait in a league, in seasons, with one dot per league", labelpad=4)
	save(fig, "fig4-longest-wait")


def main():
	p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
	p.add_argument("--font-dir", help="a folder holding the Caladea font files")
	p.add_argument("--data", help="a folder holding design.json and results.json from an earlier run")
	a = p.parse_args()
	family = set_style(a.font_dir)
	design, results = load_data(a.data)
	figure1()
	figure2(design)
	figure3(results)
	figure4(results)
	print(f"font: {family}")


if __name__ == "__main__":
	sys.exit(main())
