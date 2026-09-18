#!/usr/bin/env node
/*
 * Frontier analysis: the four criteria of the SSAC27 abstract, scored per league.
 *
 * Reads runs/frontier/<tag>.json (30 leagues x 25 seasons per mechanism; every
 * mechanism shares config id 900, so seed k is the same initial league under
 * each of them and the histories separate at the first draw). Per league:
 *
 *   targeted help     rank the fourteen non-playoff teams by the mechanism's OWN
 *                     priority standard and take the gap in draft pick between the
 *                     team ranked first and the team ranked fifth (the paper's leg
 *                     (b)); also first against the mean of the other thirteen.
 *                     Own standard: the carry-over index for the index mechanisms;
 *                     the McCarty number (drought x wins, the driver's reset rules
 *                     replayed from the log) for Countdown and Beckett; record for
 *                     the NBA lottery and 3-2-1. Wider = the mechanism concentrates
 *                     its best picks on the teams it judges most deserving.
 *   long-term parity  the longest run of consecutive seasons any team in the league
 *                     goes without winning a playoff series (a run still open at the
 *                     end of the horizon counts at its observed length), and the
 *                     number of teams that never win a series in the run. Lower is
 *                     better.
 *   robustness        the same first-vs-fifth gap with the fourteen teams ranked by
 *                     record (leg (a)), which is the reward for losing. The criterion
 *                     is max(gap, 0): at or below zero, losing buys nothing.
 *   simplicity        the first author's subjective call; not computed here.
 *
 * Seasons 1-3 are dropped from both gaps (the index is still filling from zero);
 * parity uses every season. Uncertainty is at the league level (n = leagues).
 * Leagues are paired across mechanisms, so differences are paired: the mean of the
 * per-seed difference, its SE, and a t interval (df = n-1). Pass --unpaired for
 * runs that do not share a config id (Welch SE).
 *
 * Dominance: A dominates B when A is at least as good on all three numeric
 * criteria and strictly better on at least one, on point estimates. Each edge is
 * marked "clears" when every strictly-better criterion's 95% interval on the
 * paired difference excludes zero. The frontier is the undominated set.
 *
 * Usage: node frontier_analysis.js [runsDir=runs/frontier] [--unpaired] [--legacy]
 *   --legacy scores the 48 x 15 paper runs (runs/e14, runs/ref, runs/tighten)
 *   as a check of the code; those runs are unpaired.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const ROOT = args.find((a) => !a.startsWith("--")) ?? "runs/frontier";
const LEGACY = flags.has("--legacy");
const PAIRED = !flags.has("--unpaired") && !LEGACY;
const STEADY_FROM = 3; // 0-based: drop seasons 1-3 from the two gaps

// [tag, label, own standard]
const MECHS = [
	["classic", "Classic COLA", "index"],
	["waitlist", "Waitlist COLA", "index"],
	["simple", "Simple COLA", "index"],
	["full", "COLA, full-depth lottery", "index"],
	["uniform", "Uniform lottery (flat COLA)", "index"],
	["countdown", "Countdown COLA", "countdown"],
	["beckett", "Beckett COLA", "beckett"],
	["nba", "NBA lottery, 2019 rules", "record"],
	["t321", "3-2-1 as adopted", "record"],
];
const LEGACY_FILES = {
	classic: "runs/e14/classic.json",
	waitlist: "runs/e14/mid.json",
	full: "runs/e14/g1.json",
	uniform: "runs/e14/g0.json",
	countdown: "runs/tighten/countdown.json",
	beckett: "runs/tighten/beckett.json",
	nba: "runs/ref/nba.json",
	t321: "runs/ref/t321b.json",
};

// --- stats -------------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const variance = (a) => {
	const m = mean(a);
	return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const sem = (a) => Math.sqrt(variance(a) / a.length);
// t_{0.975} for the df in use (n-1 leagues); 29 -> 2.045, 47 -> 2.012.
const tcrit = (df) => (df >= 47 ? 2.012 : df >= 29 ? 2.045 : df >= 11 ? 2.201 : 2.571);

// --- own-standard priorities ---------------------------------------------------
// Replays the driver's drought bookkeeping for the two named anchors so their
// McCarty numbers can be recovered season by season from the log.
function anchorPriorities(seasonLog, variant) {
	const drought = {};
	const out = []; // out[s][tid] = priority used for season s's draw
	for (const e of seasonLog) {
		const top6 = new Set();
		if (variant === "beckett") {
			const byConf = {};
			for (const t of e.teams) (byConf[t.conf] ??= []).push(t);
			for (const c of Object.values(byConf)) {
				c.slice()
					.sort((a, b) => b.wins - a.wins)
					.slice(0, 6)
					.forEach((t) => top6.add(t.tid));
			}
		}
		const pri = {};
		for (const t of e.teams) {
			const won = t.playoffRoundsWon >= 1;
			const reset = variant === "countdown" ? won : won || top6.has(t.tid);
			drought[t.tid] = reset ? 0 : (drought[t.tid] ?? 0) + 1;
			pri[t.tid] = drought[t.tid] * t.wins;
		}
		out.push(pri);
		for (const t of e.teams) {
			const pk = t.draftPick;
			if (pk == null) continue;
			if ((variant === "countdown" && pk <= 3) || (variant === "beckett" && pk === 1)) {
				drought[t.tid] = 0;
			}
		}
	}
	return out;
}

// Ordinary least squares slope of y on x.
function ols(xs, ys) {
	const n = xs.length;
	if (n < 2) return NaN;
	const mx = mean(xs);
	const my = mean(ys);
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
	}
	return sxx === 0 ? NaN : sxy / sxx;
}

function perLeague(seasonLog, own) {
	const anchor = own === "countdown" || own === "beckett" ? anchorPriorities(seasonLog, own) : null;
	const help5 = [];
	const helpAll = [];
	const tank = [];
	// Common yardstick for help, the same for every mechanism: seasons since the
	// team last won a playoff series (the parity criterion's own clock). Among
	// the fourteen pool teams, the slope of draft pick on that drought, sign
	// flipped so a positive value means a longer drought earns an earlier pick.
	// A slope handles the many ties a drought count produces; the first-vs-fifth
	// gap does not.
	const cx = [];
	const cy = [];
	const sinceWin = {};
	seasonLog.forEach((e, s) => {
		for (const t of e.teams) {
			sinceWin[t.tid] = t.playoffRoundsWon >= 1 ? 0 : (sinceWin[t.tid] ?? 0) + 1;
		}
		if (s < STEADY_FROM) return;
		const pool = e.teams.filter((t) => t.playoffRoundsWon < 0 && t.draftPick != null);
		if (pool.length !== 14) return;
		const byRecord = pool.slice().sort((x, y) => x.wins - y.wins);
		tank.push(byRecord[4].draftPick - byRecord[0].draftPick);
		let byOwn;
		if (own === "record") byOwn = byRecord;
		else if (anchor) byOwn = pool.slice().sort((x, y) => anchor[s][y.tid] - anchor[s][x.tid]);
		else byOwn = pool.slice().sort((x, y) => (y.colaPre ?? 0) - (x.colaPre ?? 0));
		help5.push(byOwn[4].draftPick - byOwn[0].draftPick);
		helpAll.push(mean(byOwn.slice(1).map((t) => t.draftPick)) - byOwn[0].draftPick);
		for (const t of pool) {
			cx.push(sinceWin[t.tid]);
			cy.push(t.draftPick);
		}
	});
	const helpCommon = -ols(cx, cy);
	// Parity: longest run without a playoff-series win, any team; never-winners.
	const runNow = {};
	const runMax = {};
	const everWon = {};
	for (const e of seasonLog) {
		for (const t of e.teams) {
			if (t.playoffRoundsWon >= 1) {
				runNow[t.tid] = 0;
				everWon[t.tid] = true;
			} else {
				runNow[t.tid] = (runNow[t.tid] ?? 0) + 1;
				runMax[t.tid] = Math.max(runMax[t.tid] ?? 0, runNow[t.tid]);
			}
		}
	}
	const tids = Object.keys(runNow);
	const teamMax = tids.map((k) => runMax[k] ?? 0);
	const maxDrought = Math.max(...teamMax);
	const neverWon = tids.filter((k) => !everWon[k]).length;
	// The league max saturates at the horizon whenever one franchise never wins
	// a series, so the mean of the per-team longest run is reported alongside.
	const meanTeamMax = mean(teamMax);
	return {
		help5: mean(help5),
		helpAll: mean(helpAll),
		helpCommon,
		tank: mean(tank),
		maxDrought,
		meanTeamMax,
		neverWon,
		seasons: seasonLog.length,
	};
}

// --- load ----------------------------------------------------------------------
const data = {}; // tag -> Map(seed -> perLeague)
const label = {};
for (const [tag, name, own] of MECHS) {
	const file = LEGACY ? LEGACY_FILES[tag] : path.join(ROOT, `${tag}.json`);
	if (!file || !fs.existsSync(file)) {
		console.error(`skip ${tag}: ${file ?? "no legacy file"} not found`);
		continue;
	}
	const reps = JSON.parse(fs.readFileSync(file, "utf8"));
	const m = new Map();
	for (const r of reps) m.set(r.seed, perLeague(r.seasonLog, own));
	data[tag] = m;
	label[tag] = name;
}
const tags = MECHS.map(([t]) => t).filter((t) => data[t]);
if (tags.length === 0) {
	console.error("no runs found");
	process.exit(1);
}

const col = (tag, key) => [...data[tag].values()].map((v) => v[key]);
const seasonsOf = (tag) => col(tag, "seasons")[0];
const nOf = (tag) => data[tag].size;

// Paired (or Welch) difference A - B on a per-league key.
function diff(a, b, key) {
	if (PAIRED) {
		const seeds = [...data[a].keys()].filter((s) => data[b].has(s));
		const d = seeds.map((s) => data[a].get(s)[key] - data[b].get(s)[key]);
		const m = mean(d);
		const se = sem(d);
		const tc = tcrit(d.length - 1);
		return { m, se, lo: m - tc * se, hi: m + tc * se, n: d.length };
	}
	const x = col(a, key);
	const y = col(b, key);
	const m = mean(x) - mean(y);
	const se = Math.sqrt(variance(x) / x.length + variance(y) / y.length);
	const tc = tcrit(Math.min(x.length, y.length) - 1);
	return { m, se, lo: m - tc * se, hi: m + tc * se, n: Math.min(x.length, y.length) };
}
const excludesZero = (d) => d.lo > 0 || d.hi < 0;

// --- table ---------------------------------------------------------------------
const pm = (a) => {
	const m = mean(a);
	return `${m >= 0 ? "+" : ""}${m.toFixed(2)} +/- ${sem(a).toFixed(2)}`;
};
console.log(
	`\n===== Four criteria per mechanism: ${PAIRED ? "paired leagues" : "unpaired leagues"}, ` +
		`${nOf(tags[0])} leagues x ${seasonsOf(tags[0])} seasons per arm (gaps from season ${STEADY_FROM + 1}) =====\n`,
);
console.log(
	"mechanism                     targeted help        help, 1st vs rest   help, common         parity: max drought  team mean max     never won   tanking reward     robust.",
);
console.log(
	"                              1st vs 5th, own      (draft places)      places/drought-yr    (seasons, any team)  drought (seasons) (teams)     rank by record     max(gap,0)",
);
console.log("-".repeat(171));
const summary = {};
for (const t of tags) {
	const help5 = col(t, "help5");
	const helpAll = col(t, "helpAll");
	const hc = col(t, "helpCommon");
	const md = col(t, "maxDrought");
	const tm = col(t, "meanTeamMax");
	const nw = col(t, "neverWon");
	const tk = col(t, "tank");
	summary[t] = {
		help: mean(help5),
		helpCommon: mean(hc),
		parity: mean(md),
		tankMean: mean(tk),
		robust: Math.max(mean(tk), 0),
	};
	console.log(
		`${label[t].padEnd(29)} ${pm(help5).padEnd(20)} ${pm(helpAll).padEnd(19)} ${pm(hc).padEnd(20)} ` +
			`${pm(md).padEnd(20)} ${pm(tm).padEnd(17)} ${mean(nw).toFixed(2).padStart(6)}      ${pm(tk).padEnd(18)} ${summary[t].robust.toFixed(2)}`,
	);
}
console.log(
	"\nOwn standard: carry-over index (Classic, Waitlist, Simple, full-depth, uniform); McCarty number, drought x wins,",
);
console.log(
	"replayed from the log (Countdown, Beckett); record (NBA lottery, 3-2-1), whose two columns coincide by construction.",
);
console.log(
	"Common yardstick: seasons since the team's last playoff-series win, the same clock for every mechanism; the value is",
);
console.log(
	"draft places gained per extra drought season among the fourteen pool teams (an OLS slope, sign flipped).",
);

// --- dominance -------------------------------------------------------------------
// Run twice: once with help scored on each mechanism's OWN standard (which is
// self-graded and rewards the steepest priority), once on the common yardstick.
const EPS = 1e-9;
function runDominance(helpKey, helpLabel) {
	const CRIT = [
		{ name: "help", key: helpKey, better: "high" },
		{ name: "parity", key: "maxDrought", better: "low" },
		{ name: "robust", key: "tank", better: "low", floor: true },
	];
	const pointValue = (t, c) => {
		const v =
			c.key === "tank"
				? summary[t].tankMean
				: c.key === "help5"
					? summary[t].help
					: c.key === "helpCommon"
						? summary[t].helpCommon
						: summary[t].parity;
		return c.floor ? Math.max(v, 0) : v;
	};
	// A at least as good as B on c; strict if strictly better.
	const compare = (a, b, c) => {
		const va = pointValue(a, c);
		const vb = pointValue(b, c);
		const better = c.better === "high" ? va - vb : vb - va;
		return better > EPS ? "strict" : better >= -EPS ? "tie" : "worse";
	};
	const dominates = (a, b) => {
		const strictCrits = [];
		for (const c of CRIT) {
			const r = compare(a, b, c);
			if (r === "worse") return null;
			if (r === "strict") strictCrits.push(c);
		}
		if (strictCrits.length === 0) return null;
		// clears: every strictly-better criterion's interval on the difference excludes 0
		const clears = strictCrits.every((c) => excludesZero(diff(a, b, c.key)));
		return { strictCrits: strictCrits.map((c) => c.name), clears };
	};

	console.log(
		`\n===== Dominance, help on ${helpLabel} (help higher, max drought lower, tanking reward lower) =====\n`,
	);
	const dominatedBy = {};
	for (const b of tags) {
		dominatedBy[b] = [];
		for (const a of tags) {
			if (a === b) continue;
			const d = dominates(a, b);
			if (d) dominatedBy[b].push({ a, ...d });
		}
	}
	for (const b of tags) {
		if (dominatedBy[b].length === 0) {
			console.log(`${label[b].padEnd(29)} UNDOMINATED (on the frontier before simplicity)`);
		} else {
			const by = dominatedBy[b]
				.map((d) => `${label[d.a]} [${d.strictCrits.join(",")}${d.clears ? "; clears" : "; point estimate only"}]`)
				.join("; ");
			console.log(`${label[b].padEnd(29)} dominated by ${by}`);
		}
	}
	const frontier = tags.filter((t) => dominatedBy[t].length === 0);
	console.log(`\nFrontier (${frontier.length}): ${frontier.map((t) => label[t]).join("; ")}`);
	for (const base of ["nba", "t321"]) {
		if (!data[base]) continue;
		const all = dominatedBy[base];
		const clear = all.filter((d) => d.clears);
		console.log(
			`Mechanisms dominating ${label[base]}: ${all.length} on point estimates (${all.map((d) => label[d.a]).join(", ") || "none"}); ` +
				`${clear.length} with every strict criterion clearing its interval (${clear.map((d) => label[d.a]).join(", ") || "none"}).`,
		);
	}
	if (data.nba && data.t321) {
		const both = tags.filter(
			(t) => dominatedBy.nba.some((d) => d.a === t) && dominatedBy.t321.some((d) => d.a === t),
		);
		const bothClear = both.filter(
			(t) => dominatedBy.nba.find((d) => d.a === t).clears && dominatedBy.t321.find((d) => d.a === t).clears,
		);
		console.log(
			`Mechanisms dominating BOTH baselines: ${both.length} (${both.map((t) => label[t]).join(", ") || "none"}); ` +
				`with intervals clearing: ${bothClear.length} (${bothClear.map((t) => label[t]).join(", ") || "none"}).`,
		);
	}
}
runDominance("help5", "each mechanism's OWN standard");
runDominance("helpCommon", "the COMMON yardstick, series-win drought");

// --- pairwise differences against the reference rules ------------------------------
const fmtD = (d) =>
	`${d.m >= 0 ? "+" : ""}${d.m.toFixed(2)} [${d.lo.toFixed(2)}, ${d.hi.toFixed(2)}]${excludesZero(d) ? " " : "*"}`;
for (const ref of ["nba", "t321", "waitlist"]) {
	if (!data[ref]) continue;
	console.log(`\n===== Differences against ${label[ref]} (mechanism minus reference; ${PAIRED ? "paired by league" : "Welch"}; * = interval includes 0) =====\n`);
	console.log(
		"mechanism                     help 1st vs 5th, own        help, common yardstick      max drought (seasons)       tanking gap by record",
	);
	console.log("-".repeat(140));
	for (const t of tags) {
		if (t === ref) continue;
		console.log(
			`${label[t].padEnd(29)} ${fmtD(diff(t, ref, "help5")).padEnd(27)} ${fmtD(diff(t, ref, "helpCommon")).padEnd(27)} ` +
				`${fmtD(diff(t, ref, "maxDrought")).padEnd(27)} ${fmtD(diff(t, ref, "tank"))}`,
		);
	}
}
