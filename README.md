# Wasp Bounty

**A refundable bond on open source security reports.**

Reporting is always free. The bond only ever buys **priority** — never permission.

---

## The problem

In January 2026 curl ended its HackerOne bug bounty. Not because the programme
failed — it had paid out around $90,000 across ~81 awards since 2019 — but
because AI-generated reports arrived faster than a human could read them.
Daniel Stenberg reported an **8× surge in a single week**. He had already
required AI disclosure. He had already banned the reporters sending slop.
Neither worked, so he closed the door.

OpenSSF puts triage at **two to eight hours per security report**. The sender
pays nothing. That asymmetry is the whole problem, and no amount of policy fixes
an economics bug.

## What this does

A reporter posts a bond with a report.

| verdict | outcome |
|---|---|
| **Valid** | bond refunded in full, **and a reputation tier is granted** |
| **Good faith but wrong** | bond refunded **in full** |
| **Fabricated** | bond slashed → goes to a **triage pool the maintainer cannot touch** |

Three verdicts, not two. **Being wrong is not slop** — most honest security
reports are wrong, and a design that punishes being wrong drives out the people
it needs.

And the maintainer posts a bond too: a promise to answer within a window. If they
ghost, **anyone** can call it and the reporter is paid automatically. It is not a
one-sided tax on researchers.

---

## Run it

Requires **Node ≥ 22.10**.

```bash
npm install
cp .env.example .env     # then fill in the values
npm run compile          # solc-js -> build/
npm run chain            # local EVM, separate terminal
npm test                 # 14 tests
npm run serve            # app on http://localhost:4318
```

| command | what it does |
|---|---|
| `npm run arkiv:check` | connectivity, chain id, signer balance |
| `npm run arkiv:read` | runs all six Arkiv queries against Rabdi |
| `npm run arkiv:write` | writes a report entity with a 90-day expiry |
| `npm run ens:probe` | read-only ENSv2 check on Sepolia (spends nothing) |
| `npm run zerog:models` | live 0G router model catalogue |

---

## Arkiv

**Network:** Rabdi, chain **7794095**, RPC
`https://rpc.rabdi.db-chain.testnet.arkiv.network`, gas **tGLM**.

**Writing wallet:** `0x4CA8176777D44B76235684b63334088C618994e4`

Four schemas — `wasp.report`, `wasp.clock`, `wasp.verdict`, `wasp.tier`.
Declared in [`src/arkiv/schema.mjs`](src/arkiv/schema.mjs).

### A query a judge can run

No key or wallet needed for reads. From the repo root:

```bash
npm install
npm run arkiv:read
```

That executes all six production queries and prints row counts and latency. Or
run the single board query directly:

```js
import { createPublicClient, http } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { eq, str, asc } from "@arkiv-network/sdk/query";
import { Report } from "./src/arkiv/schema.mjs";

const reader = createPublicClient({
  chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY }),
  transport: http(),
});

const { entities } = await reader
  .select({ $key: true, $expiresAt: true, caseId: true, repo: true,
            severity: true, state: true, disclosureAt: true })
  .from(Report)
  .where(eq("state", str("open")))
  .orderBy(asc("disclosureAt"))
  .limit(50)
  .fetch();

console.log(entities);
```

This is the exact query behind the **Disclosure Board** tab. Remove Arkiv and
that screen is empty — there is no second copy in a database somewhere.

### The four judged files

[`arkiv/friction.md`](arkiv/friction.md) ·
[`arkiv/reach.md`](arkiv/reach.md) ·
[`arkiv/why-arkiv.md`](arkiv/why-arkiv.md) ·
[`arkiv/how-you-use-arkiv.md`](arkiv/how-you-use-arkiv.md) ·
plus [`arkiv/schema.md`](arkiv/schema.md)

**Why Arkiv and not Postgres, in one line:** a report expires on day 90 by
itself, and the *only* way it lives longer is a signed `extendEntity` that emits
`onExpiryExtended`. Natural expiry emits nothing. So silence is normal and the
one loud event is somebody buying more time — which makes "the vendor asked for
an extension" a public fact instead of a claim. In Postgres that is one silent
`UPDATE`.

---

## ENSv2

Reputation tiers are **roles on an ENSv2 name**, read directly by the bond
contract to waive the bond:

```solidity
uint256 public constant ROLE_TIER_1 = 1 << 40;
uint256 public constant ROLE_TIER_2 = 1 << 44;
uint256 public constant ROLE_TIER_3 = 1 << 48;
```

`EnhancedAccessControl` validates every bitmap against
`ALL_ROLES = 0x1111…1111`, so **each nybble is a boolean, not a level 0–15** —
`0xF << 40` is rejected with `EACInvalidRoleBitmap`. There is a test asserting
exactly that, because the opposite assumption is an easy one to ship.

`hasRoles` takes a **`uint256`**, not `bytes32`. Confirmed against the deployed
Sepolia registry with `npm run ens:probe`.

## 0G Private Computer

The first opinion on whether a report is fabricated comes from a model in a
sealed enclave, called with `X-0G-Provider-Trust-Mode: private`, and the request
id is stored on-chain next to the bond so a slashed reporter can audit the basis.

**The enclave never sentences anyone.** It gives a first opinion; a human signs
the outcome. We never slash on an unreviewed machine verdict.

### Which model, and why it matters

0G's docs never say which models actually run **inside** the enclave. The
catalogue does, in a field that is easy to miss:

- `verifiability: "TeeML"` → TDX, dstack verifier. **The model runs in the enclave.**
- `verifiability: "TeeTLS"` → transport encryption only. **The model does not.**

Only **7 of 123** models carry a verifiability value at all (6 TeeML, 1 TeeTLS,
verified live 2026-11-06), and of those only a few are chat models. We pin
`0gm-1.0-35b-a3b` — TeeML, TDX, dstack, 262k context — and
[`assertTeeML()`](src/triage/zerog.mjs) **refuses to run at all** if the
catalogue stops reporting it as TeeML, rather than quietly falling back.

`X-0G-Provider-Trust-Mode: private` returns **503 rather than silently
downgrading**, which is what makes the claim safe to state out loud.

> **Note:** we treat `tee_attested` / `verify_tee` as the router's **self-report**
> and label it that way on screen. We store the request id (`ZG-Res-Key`),
> provider and trust mode; we do not claim a verified provider signature unless
> we actually checked one.

---

## Contract

[`contracts/WaspBounty.sol`](contracts/WaspBounty.sol) — 6234 bytes.

Mutual bail, three verdicts, `claimGhosted()` callable by anyone, a triage pool
the deciding party cannot withdraw from, ENS tier waiver, reentrancy guard, and
USDT-style tokens that return nothing from `transfer`.

**14 tests passing** (`node:test` + viem against a local chain), covering refund,
slash routing, ghost claims, the tier waiver at each level, steward-only pool
withdrawal, and the `EACInvalidRoleBitmap` rejection.

### Deployed — Sepolia (chain 11155111)

| | address |
|---|---|
| **WaspBounty** | [`0xb9e8e49725d25a23e136d2e5d45858d1eb6abcac`](https://sepolia.etherscan.io/address/0xb9e8e49725d25a23e136d2e5d45858d1eb6abcac) |
| **MockToken** (demo bond currency) | [`0xcc6763c579f0d612ff02934d6c159bde3ed90acb`](https://sepolia.etherscan.io/address/0xcc6763c579f0d612ff02934d6c159bde3ed90acb) |
| **ENSv2 ETHRegistry** (not ours — live) | [`0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4`](https://sepolia.etherscan.io/address/0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4) |
| Deployer / triage steward | `0x4CA8176777D44B76235684b63334088C618994e4` |

**The contract is pointed at the real ENSv2 registry, not a mock.** `bondFor()`
reaches live chain state to decide whether a reporter's tier waives the bond.
You can check that yourself without spending anything:

```bash
cast call 0xb9e8e49725d25a23e136d2e5d45858d1eb6abcac \
  "bondFor(address,uint256)(uint256)" \
  0x0000000000000000000000000000000000000001 0 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

Returns `0` — a reporter who has never submitted posts no bond. **Reporting is
free by default**, which is the whole design, enforced on-chain.

`MockToken` is ours and exists because Sepolia has no canonical stablecoin. We
say so rather than implying a real asset is at stake.

---

## AI-use disclosure

This project was built with heavy use of **Claude (Anthropic)** as a coding
assistant, in Claude Code.

- **Written with AI assistance:** the Solidity contract, the Arkiv integration,
  the application server and front end, the test suite, the build scripts, and
  the documentation in this repository including the files in `arkiv/`.
- **Done by a human:** the idea, the mechanism design (three verdicts, mutual
  bail, the triage pool), every product decision, all credential and wallet
  handling, and review of what shipped.
- **Verified rather than trusted:** API behaviour was probed live rather than
  recalled — the ENSv2 `hasRoles` signature, the nybble-is-a-boolean constraint,
  the chain-wide `watchEntityEvents` firehose, and the 0G catalogue change noted
  above were all found by probing and are documented in `arkiv/friction.md`.

No claim in this repository about a third-party API is made from memory alone.
Where something could not be confirmed, it is marked unconfirmed rather than
asserted.

## Licence

[MIT](LICENSE).

---

Built at **ETHGlobal Mumbai 2026**.
