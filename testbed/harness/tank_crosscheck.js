#!/usr/bin/env node
/**
 * Clean-room cross-check of the Sim 3 headline.
 *
 * tank_counterfactual.js computes the answer exactly, by enumerating the draw.
 * An enumeration bug would be invisible to any test that reuses the enumeration,
 * so this script re-derives the same number a different way. It shares no code
 * with pick_dist.js: all three mechanisms are re-implemented from scratch here,
 * and the draw is sampled rather than enumerated, with paired common random
 * numbers across the two arms and a per-season jitter so both arms resolve
 * identical ties identically.
 *
 * Agreement to Monte Carlo error is the check. Expected (exact) values are
 * NBA +1.321, Classic +1.869, Waitlist 0.000.
 *
 * Usage: node tank_crosscheck.js
 */
const fs = require("fs");

const NBA_BALLS=[140,140,140,125,105,90,75,60,45,30,20,15,10,5];
function order(pool, mech, rnd){
  // pool: [{tid,wins,cola}] -> {tid: pick}
  let w, tailCmp;
  if(mech==="nba"){
    const ranked=pool.slice().sort((a,b)=>a.wins-b.wins);
    const idx=new Map(ranked.map((t,i)=>[t.tid,i]));
    w=t=>NBA_BALLS[idx.get(t.tid)] ?? 5;
    tailCmp=(a,b)=>a.wins-b.wins;
  } else if(mech==="classic"){ w=t=>t.cola; tailCmp=(a,b)=>a.wins-b.wins; }
  else { w=t=>t.cola; tailCmp=(a,b)=>b.cola-a.cola; }
  const rem=pool.slice(); const out={}; let p=1;
  for(let k=0;k<4 && rem.length;k++){
    const tot=rem.reduce((s,t)=>s+w(t),0); if(tot<=0) break;
    let r=rnd()*tot, c=0, pick=0;
    for(let i=0;i<rem.length;i++){ c+=w(rem[i]); if(r<c){pick=i;break;} }
    out[rem[pick].tid]=p++; rem.splice(pick,1);
  }
  // deterministic tail; ties resolved by a fixed jitter drawn ONCE per season so
  // both arms of the pair break identical ties identically
  rem.sort((a,b)=> tailCmp(a,b) || (a._j-b._j));
  for(const t of rem) out[t.tid]=p++;
  return out;
}
function mulberry(seed){return function(){let t=(seed+=0x6d2b79f5);t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
const DRAWS=4000;
for(const [mech,f] of [["nba","runs/ref/nba.json"],["classic","runs/e14/classic.json"],["waitlist","runs/e14/mid.json"]]){
  const d=JSON.parse(fs.readFileSync(f,"utf8"));
  let sum=0,n=0,maxAbs=0;
  for(const rep of d) for(const [si,e] of rep.seasonLog.entries()){
    const raw=e.teams.filter(t=>t.playoffRoundsWon<0); if(raw.length!==14) continue;
    const jit={}; const jr=mulberry(si*7919+n); for(const t of raw) jit[t.tid]=jr();
    const base=raw.map(t=>({tid:t.tid,wins:t.wins,cola:t.colaPre,_j:jit[t.tid]}));
    const ranked=base.slice().sort((a,b)=>a.wins-b.wins);
    const tid=ranked[4].tid, worst=ranked[0].wins-1;
    const alt=base.map(t=>t.tid===tid?{...t,wins:worst}:t);
    let sb=0,sa=0;
    for(let k=0;k<DRAWS;k++){
      const r1=mulberry(n*1000003+k), r2=mulberry(n*1000003+k); // paired streams
      sb+=order(base,mech,r1)[tid]; sa+=order(alt,mech,r2)[tid];
    }
    const g=(sb-sa)/DRAWS; sum+=g; n++; maxAbs=Math.max(maxAbs,Math.abs(g));
  }
  console.log(`${mech.padEnd(9)} MC mean gain (5th-worst -> worst) = ${(sum/n).toFixed(3)} picks over ${n} seasons x ${DRAWS} draws  (max |gain| ${maxAbs.toFixed(3)})`);
}
