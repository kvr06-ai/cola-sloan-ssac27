// Checks a Classic COLA run against its rule. Usage: node verify_classic.js <file.json> [...]
// For every league and season: the 14 teams that missed the playoffs hold picks 1-14;
// picks 5-14 go in reverse order of record; a first-round loser gains 1,000 tickets;
// picks 1-4 cost 100%, 75%, 50% and 25% of a team's tickets; and season 1 matches the
// other mechanisms win for win (the shared-leagues design).
const fs = require("fs");
const files = process.argv.slice(2);
const ref = {};
for (const tag of ["waitlist", "nba"]) {
	const p = `runs/frontier/${tag}.json`;
	if (fs.existsSync(p)) ref[tag] = Object.fromEntries(JSON.parse(fs.readFileSync(p, "utf8")).map((r) => [r.seed, r.seasonLog[0].teams]));
}
const DECAY = [0, 0.25, 0.5, 0.75];
let leagues = 0, seasons = 0;
const bad = { pool: 0, tail: 0, r1: 0, decay: 0, pair: 0, shape: 0 };
let r1Cases = 0, decayCases = 0;
for (const f of files) {
	for (const rep of JSON.parse(fs.readFileSync(f, "utf8"))) {
		leagues++;
		if (rep.seasonLog.length !== 25) bad.shape++;
		for (const tag of Object.keys(ref)) {
			const w = Object.fromEntries(ref[tag][rep.seed].map((t) => [t.tid, t.wins]));
			if (!rep.seasonLog[0].teams.every((t) => t.wins === w[t.tid])) bad.pair++;
		}
		rep.seasonLog.forEach((e, i) => {
			seasons++;
			if (e.teams.length !== 30) bad.shape++;
			const np = e.teams.filter((t) => t.playoffRoundsWon < 0);
			if (np.length !== 14 || !np.every((t) => t.draftPick <= 14)) bad.pool++;
			const tail = np.filter((t) => t.draftPick >= 5).sort((a, b) => a.draftPick - b.draftPick);
			for (let k = 1; k < tail.length; k++) if (tail[k].wins < tail[k - 1].wins) { bad.tail++; break; }
			for (const t of np.filter((x) => x.draftPick <= 4)) {
				decayCases++;
				if (t.cola !== Math.round(t.colaPre * DECAY[t.draftPick - 1])) bad.decay++;
			}
			if (i > 0) {
				const prev = Object.fromEntries(rep.seasonLog[i - 1].teams.map((t) => [t.tid, t.cola]));
				for (const t of e.teams.filter((x) => x.playoffRoundsWon === 0)) {
					r1Cases++;
					if (t.cola !== prev[t.tid] + 1000) bad.r1++;
				}
			}
		});
	}
}
console.log(`leagues ${leagues}, seasons ${seasons}`);
console.log(`first-round losers gaining 1,000 tickets: ${r1Cases - bad.r1} of ${r1Cases}`);
console.log(`top-four ticket costs correct: ${decayCases - bad.decay} of ${decayCases}`);
console.log(`seasons with a wrong pool: ${bad.pool}; with picks 5-14 out of record order: ${bad.tail}`);
console.log(`leagues whose first season differs from another mechanism's: ${bad.pair}; malformed leagues or seasons: ${bad.shape}`);
