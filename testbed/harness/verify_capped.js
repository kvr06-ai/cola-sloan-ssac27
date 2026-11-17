// Checks a Capped COLA run against its rules. Usage: node verify_capped.js <file.json> [...]
// For every league and season it replays the rules from the logged wins, seeds and
// playoff results: the stockpile each team took into the drawing (growth by wins
// outside the top six seeds, up to 150 tickets, less 10% or 20% for a round-1 loss);
// the pool (no series win this season or last, no top-five pick last season); the
// order (five picks drawn from the pool, the rest of the pool by tickets and then
// wins, the teams outside the pool after it in the same order); and the stockpile
// after the draft (picks 1 to 5 give up 100% to 20%, 1 to 4 series won 40% to 100%).
// It also checks the first-round seeds and that season 1 matches the other
// mechanisms win for win (the shared-leagues design), and counts the teams at the
// cap and the top-five picks a team had traded away (the enhanced Stepien rule is
// not enforced in the run).
const fs = require("fs");
const MAX = 150;
const KEEP_R1_PLAYIN = 0.9;
const KEEP_R1_DIRECT = 0.8;
const KEEP_BY_SERIES = [1, 0.6, 0.4, 0.2, 0];
const KEEP_BY_PICK = [0, 0.2, 0.4, 0.6, 0.8];
const toCent = (x) => Math.round(x * 100) / 100;

const files = process.argv.slice(2);
const ref = {};
for (const tag of ["waitlist", "nba"]) {
	const p = `runs/frontier/${tag}.json`;
	if (fs.existsSync(p)) ref[tag] = Object.fromEntries(JSON.parse(fs.readFileSync(p, "utf8")).map((r) => [r.seed, r.seasonLog[0].teams]));
}
let leagues = 0, seasons = 0, teamSeasons = 0;
const bad = { shape: 0, seeds: 0, before: 0, picks: 0, drawn: 0, poolOrder: 0, outsideOrder: 0, after: 0, cap: 0, pair: 0 };
let shortDraws = 0, atCap = 0, maxAtCap = 0, topFive = 0, topFiveTraded = 0;
for (const f of files) {
	for (const rep of JSON.parse(fs.readFileSync(f, "utf8"))) {
		leagues++;
		for (const tag of Object.keys(ref)) {
			if (!ref[tag][rep.seed]) continue;
			const w = Object.fromEntries(ref[tag][rep.seed].map((t) => [t.tid, t.wins]));
			if (!rep.seasonLog[0].teams.every((t) => t.wins === w[t.tid])) bad.pair++;
		}
		let stock = {};
		let excluded = new Set();
		for (const e of rep.seasonLog) {
			seasons++;
			const teams = e.teams;
			if (teams.length !== 30) bad.shape++;
			// Seeds: seeds 1 to 8 once in each conference, held by exactly the playoff teams.
			for (const conf of ["E", "W"]) {
				const seeds = teams.filter((t) => t.conf === conf && t.seed != null).map((t) => t.seed).sort((a, b) => a - b);
				if (seeds.join() !== "1,2,3,4,5,6,7,8") bad.seeds++;
			}
			if (!teams.every((t) => (t.seed != null) === (t.playoffRoundsWon >= 0))) bad.seeds++;
			// Tickets into the drawing.
			const lottery = {};
			for (const t of teams) {
				teamSeasons++;
				const s0 = stock[t.tid] ?? 0;
				let s = t.seed != null && t.seed <= 6 ? s0 : toCent(Math.min(MAX, s0 + t.wins));
				if (t.playoffRoundsWon === 0) s = toCent(s * (t.seed >= 7 ? KEEP_R1_PLAYIN : KEEP_R1_DIRECT));
				lottery[t.tid] = s;
				if (t.colaPre !== s) bad.before++;
				if (t.colaPre > MAX || t.cola > MAX) bad.cap++;
			}
			const capped = teams.filter((t) => lottery[t.tid] === MAX).length;
			atCap += capped;
			maxAtCap = Math.max(maxAtCap, capped);
			// Order.
			const picks = teams.map((t) => t.draftPick).sort((a, b) => a - b);
			if (picks.join() !== Array.from({ length: 30 }, (_, i) => i + 1).join()) bad.picks++;
			const byTickets = (a, b) => lottery[b.tid] - lottery[a.tid] || b.wins - a.wins || a.tid - b.tid;
			const pool = teams.filter((t) => t.playoffRoundsWon < 1 && !excluded.has(t.tid));
			const outside = teams.filter((t) => !(t.playoffRoundsWon < 1 && !excluded.has(t.tid))).sort(byTickets);
			const positive = pool.filter((t) => lottery[t.tid] > 0).length;
			const nDrawn = Math.min(5, positive);
			if (nDrawn < 5) shortDraws++;
			const drawn = pool.filter((t) => t.draftPick <= nDrawn);
			if (drawn.length !== nDrawn || !drawn.every((t) => lottery[t.tid] > 0)) bad.drawn++;
			const rest = pool.filter((t) => t.draftPick > nDrawn).sort(byTickets);
			if (!rest.every((t, i) => t.draftPick === nDrawn + 1 + i)) bad.poolOrder++;
			if (!outside.every((t, i) => t.draftPick === pool.length + 1 + i)) bad.outsideOrder++;
			// Tickets after the draft, and next season's exclusions.
			const next = new Set();
			for (const t of teams) {
				let s = lottery[t.tid];
				if (t.draftPick <= 5) {
					s = toCent(s * KEEP_BY_PICK[t.draftPick - 1]);
					next.add(t.tid);
					topFive++;
					if (t.pickHolder != null && t.pickHolder !== t.tid) topFiveTraded++;
				}
				if (t.playoffRoundsWon >= 1) {
					s = toCent(s * KEEP_BY_SERIES[t.playoffRoundsWon]);
					next.add(t.tid);
				}
				if (t.cola !== s) bad.after++;
			}
			stock = Object.fromEntries(teams.map((t) => [t.tid, t.cola]));
			excluded = next;
		}
	}
}
const errors = Object.values(bad).reduce((a, b) => a + b, 0);
console.log(`leagues ${leagues}, seasons ${seasons}, team-seasons ${teamSeasons}`);
console.log(`tickets into the drawing wrong: ${bad.before} of ${teamSeasons}; tickets after the draft wrong: ${bad.after} of ${teamSeasons}; over the cap: ${bad.cap}`);
console.log(`seasons with wrong seeds: ${bad.seeds}; wrong pick numbers: ${bad.picks}; wrong drawn picks: ${bad.drawn}; rest of the pool out of order: ${bad.poolOrder}; teams outside the pool out of order: ${bad.outsideOrder}`);
console.log(`seasons whose drawing ended early (fewer than five pool teams with tickets): ${shortDraws}`);
console.log(`teams at the 150-ticket cap at the drawing: ${atCap} team-seasons, at most ${maxAtCap} in one season`);
console.log(`top-five picks held by another team on lottery day: ${topFiveTraded} of ${topFive}`);
console.log(`leagues whose first season differs from another mechanism's: ${bad.pair}; malformed seasons: ${bad.shape}`);
console.log(errors === 0 ? "OK: every rule holds" : `FAIL: ${errors} mismatches`);
process.exitCode = errors === 0 ? 0 : 1;
