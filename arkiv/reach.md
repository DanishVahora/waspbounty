# Reach

Who this is for, and whether they would actually use it.

---

## The person

**A maintainer of a widely-depended-on open source project who has a security
inbox they can no longer read.**

Not a hypothetical. The clearest case is curl. Daniel Stenberg had a HackerOne
bug bounty running since 2019 — roughly **$90,000 paid across ~81 awards**. In
mid-2025 he reported AI-generated reports arriving at **eight times** the usual
rate in a single week. He tried the two obvious fixes first:

1. **Require reporters to disclose AI use.** It was already policy. It did not work.
2. **Ban reporters who submit slop.** He did. It did not stop.

**At the end of January 2026 curl ended the bug bounty entirely.**

That is the shape of the problem. It is not that maintainers cannot tell good
reports from bad ones — Stenberg could. It is that *reading far enough to tell*
is the expensive part, and nothing in the system makes the sender carry any of
that cost. An OpenSSF estimate presented at KubeCon Europe 2026 puts triage at
**two to eight hours per security report**. At eight times volume, a volunteer
maintainer is being handed a full-time job they did not apply for.

Seth Larson, in the Python Software Foundation's security role, described the
same thing across projects — "low-quality, spammy, and LLM-hallucinated security
reports" — and noted the second-order damage: it drains the volunteer time that
made the project exist, and it discourages people from contributing at all.

The money has noticed. In March 2026 the Linux Foundation announced **$12.5M in
grants** through Alpha-Omega and OpenSSF aimed at open source security capacity.
That is a real signal, but it funds *more triage labour*. It does not change the
economics that produce the flood.

---

## What they do today, and why each one fails

| Current fix | Why it fails |
|---|---|
| Require AI disclosure | Honest people comply. The people generating slop do not. curl had this policy *before* the flood. |
| Ban bad reporters | Accounts are free. Stenberg banned people; the volume kept rising. |
| Close the bounty | Works, and curl did it. But it also closes the door on the legitimate researchers, who are the reason the programme existed. |
| Pay a triage service | Only projects with funding can. The long tail of critical infrastructure has no budget. |

Every one of these is a filter applied **after** the maintainer's attention has
already been spent, or a blunt instrument that costs them the good reports too.

---

## Why they would use this

The one thing none of the above does is **make the sender carry a cost that an
honest sender gets back**.

- **Reporting is always free.** There is a free lane that never requires a bond.
  This matters more than anything else in this document: a system that taxes
  researchers to report vulnerabilities is worse than the problem. The bond only
  ever buys **priority** — a place at the front of the queue — never permission.
- **Being wrong is refunded.** Three verdicts, not two. A good-faith report that
  turns out incorrect is returned in full. Most honest security reports are
  wrong, and a design that punishes being wrong would drive out exactly the
  people it needs. Only fabrication is slashed.
- **The maintainer is bound too.** They post a bond that they will answer within
  a stated window. If they ghost, **anyone** can call it and the reporter is paid.
  This is the part that makes it acceptable to a researcher: it is not a
  one-sided tax dressed up as a filter.
- **The slashed bond never reaches the maintainer.** It goes to a triage pool the
  deciding party cannot withdraw from. Otherwise the maintainer has a financial
  incentive to call things fabricated, and the whole thing collapses.
- **Standing travels.** A reporter who has been right at one project carries a
  tier to the next one and posts a smaller bond, or none. Today reputation is
  locked inside each platform's private account system.

---

## Would they actually adopt it — honestly

**Probably not curl, and not immediately.** A project with Stenberg's profile has
already solved this by closing the door, and has the standing to make that stick.
Asking them to adopt an unproven mechanism with a crypto wallet attached is a
large ask for a problem they consider closed.

**The realistic first users are the projects underneath curl**: maintainers of
widely-depended-on libraries who have the same inbox problem and none of the
profile, funding, or leverage to simply shut it down. They are the long tail that
the $12.5M does not reach. For them the alternative to a filter is not "close the
bounty" — it is "stop reading security mail," which is how vulnerabilities go
unpatched.

**The honest obstacles:**

- **A wallet is friction.** A maintainer who does not care about crypto will not
  install one to receive bail money. The answer has to be that the free lane
  works with no wallet at all, and that is a design constraint we accept, not a
  gap we hide.
- **Who decides "fabricated" is the whole argument.** If we decide, nobody
  participates. That is why the first opinion comes from a model in a sealed
  enclave with a checkable request id, and why a human always signs the outcome.
  We never slash on an unreviewed machine verdict. It is still the weakest joint
  in the design and we say so.
- **It needs liquidity on both sides.** A bond system with one maintainer and no
  reporters is a demo, not a market.

---

## What would tell us we were right

Not downloads. One maintainer who had closed their security intake **reopening
it** — and a reporter who was refunded after being wrong saying publicly that
they would file again. The second one matters more. If honest researchers who
were wrong feel punished, the design has failed regardless of how many bonds
it processed.

---

**Sources:** curl's bug bounty shutdown was reported in January 2026 by
BleepingComputer, Neowin, heise, It's FOSS and others; the 8× surge figure and
the prior AI-disclosure policy are Stenberg's own. Triage cost (2–8 hours per
report) is an OpenSSF figure presented at KubeCon Europe 2026. The $12.5M
Alpha-Omega/OpenSSF grants were announced in March 2026. Seth Larson's
description is from his Python Software Foundation security work. Payout totals
vary by source ($86k/78 and $90k/81 both appear); we cite the range rather than
pick one.
