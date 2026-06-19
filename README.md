# COLA Family — MIT Sloan SSAC27 submission (working draft)

A compressed, audience-fit derivative of the long-form Carry-Over Lottery Allocation (COLA) paper, targeting the MIT Sloan Sports Analytics Conference Research Paper Competition (SSAC27 cycle, March 2027 in Boston).

## Status

Phase 1 (skeleton + voice locks) done 2026-05-26. Phase 2 (framework integration into §3 + Basketball-GM empirical testbed) in progress; critical-path for the SSAC27 abstract deadline (~Oct 1, 2026).

**Rescope per Highley (~2026-05-26).** The Sloan paper's two anchor contributions are (a) the seven-dial framework formalization and (b) a Basketball-GM empirical Pareto-optimization testbed. Highley's reply to our May 19 strategic email named these as the paper's "significant new contribution"; on the framework, "the 'framework' research should maybe come first, so we know what shape of draft we want to optimize for"; on the testbed, "we could use it to optimize for various parameters" (example: minimize max years between conference finals appearances).

The manipulation bound and historical backtest are present in the paper as supporting analytical properties of the framework, not as co-equal contributions. Highley: "the analytic bound on Classic COLA could be something stand-alone. However, I don't think it is significant enough to get past peer-review on its own."

The Phase 1 skeleton currently lists §1 contributions in the pre-rescope structure (framework + bound + backtest as co-equal). Phase 2 re-prioritizes that list: §3 expands to ~3 pages with the framework as lead; §4 compresses to ~1.5 pages renamed "Framework Properties"; §5 rebuilds around the Basketball-GM testbed (~2.5 pages) with the historical backtest folded in as secondary framework validation.

The long version of this paper lives at `../cola-manipulation-bound/`; the IJCAI peel from May 2026 (dropped 2026-05-09 due to Bremen travel infeasibility) lives at `../../workshop-submissions/cola-cfd-ijcai-2026/`. This Sloan version inherits Highley's `96c946b` source-fidelity corrections from the IJCAI peel and adds the seven-dial configuration-space framework from the long paper.

## Deadlines

- **Abstract**: ~Oct 1, 2026 (500 words, structured Introduction / Methods / Results / Conclusion, max 2 figures or tables)
- **Full paper**: ~Dec 7, 2026 if abstract invited (~10–12 pages single-column, format details TBD at invitation)
- **Conference**: early March 2027, Boston

## Build

`tectonic paper/main.tex` produces `paper/main.pdf`.

## Companion artifacts

- Long paper (comprehensive reference, source of section content): `../cola-manipulation-bound/paper/`
- Open-source reproducibility repository (CFP requirement): https://github.com/kvr06-ai/cola-manipulation-bound
- IJCAI peel (frozen, structural template): `../../workshop-submissions/cola-cfd-ijcai-2026/`

## Plan

See `~/.claude/plans/let-s-work-on-the-buzzing-twilight.md` for the full compression plan, working targets, and per-section compression decisions.
