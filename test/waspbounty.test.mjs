/* ============================================================================
   WaspBounty contract tests.

   Runs against any JSON-RPC at TEST_RPC (default http://127.0.0.1:8545) with
   unlocked, funded dev accounts — e.g. `npx hardhat node`.

   Run:  npm run chain      (in one terminal)
         npm test           (in another)

   These test the claims we make out loud, not just the happy path:
     · being wrong is refunded, only fabrication is slashed
     · the maintainer never receives a slashed bond
     · the maintainer can be made to pay for ghosting, by anyone
     · a tier read from ENS waives the bond
     · a nybble is a boolean — 0xF<<40 is rejected by the registry
     · the triage pool cannot be drained by a stranger
   ========================================================================= */

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEther, keccak256, toHex, getAddress } from "viem";
import { foundry } from "viem/chains";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(HERE, "..", "build");
const RPC = process.env.TEST_RPC || "http://127.0.0.1:8545";

const artifact = (n) => JSON.parse(fs.readFileSync(path.join(BUILD, `${n}.json`), "utf8"));

const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });

let accounts, maintainer, reporter, steward, stranger;
let wallets = {};

const BASE_BOND = parseEther("0.01");
const POOL = parseEther("1");
const WINDOW = 72n * 60n * 60n;
const REPO_ID = keccak256(toHex("curl/curl"));
const ARKIV_KEY = keccak256(toHex("zmt-entity-1"));
const LABEL = BigInt(keccak256(toHex("newcomer")));

const ROLE_TIER_1 = 1n << 40n;
const ROLE_TIER_2 = 1n << 44n;
const ROLE_TIER_3 = 1n << 48n;

async function deploy(name, args = [], from) {
  const a = artifact(name);
  const hash = await wallets[from].deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress, abi: a.abi };
}

const read = (c, fn, args = []) => pub.readContract({ address: c.address, abi: c.abi, functionName: fn, args });

async function write(c, fn, args, from) {
  const hash = await wallets[from].writeContract({ address: c.address, abi: c.abi, functionName: fn, args });
  return pub.waitForTransactionReceipt({ hash });
}

async function expectRevert(p, name) {
  try {
    await p;
    assert.fail(`expected revert ${name}, but it succeeded`);
  } catch (e) {
    // revert data can contain BigInts, which JSON.stringify refuses outright
    const safe = (v) => { try { return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)); } catch { return ""; } };
    const s = [safe(e.cause?.data), e.cause?.data?.errorName, e.shortMessage, e.message, e.metaMessages?.join(" ")]
      .filter(Boolean).join(" ");
    assert.ok(s.includes(name), `expected revert "${name}", got: ${(e.shortMessage || e.message || "").slice(0, 220)}`);
  }
}

/* a fresh world per test group, so nothing leaks between assertions */
async function world({ tokenName = "MockToken" } = {}) {
  const token = await deploy(tokenName, [], "maintainer");
  const ens = await deploy("MockENSRegistry", [], "maintainer");
  const z = await deploy("WaspBounty", [token.address, ens.address, BASE_BOND, steward], "maintainer");

  for (const who of ["maintainer", "reporter", "stranger"]) {
    await write(token, "mint", [wallets[who].account.address, parseEther("100")], who);
    await write(token, "approve", [z.address, parseEther("100")], who);
  }
  await write(z, "registerRepo", [REPO_ID, POOL, WINDOW], "maintainer");
  return { token, ens, z };
}

const bal = (token, who) => read(token, "balanceOf", [who]);

before(async () => {
  accounts = await pub.request({ method: "eth_accounts" });
  assert.ok(accounts.length >= 4, `need >=4 unlocked accounts at ${RPC}; got ${accounts.length}`);
  // NOT accounts.map(getAddress): map passes the index as viem's second
  // argument, which is chainId, producing EIP-1191 chain-specific checksums
  // that then fail validation.
  [maintainer, reporter, steward, stranger] = accounts.map((a) => getAddress(a));
  for (const [name, addr] of [["maintainer", maintainer], ["reporter", reporter], ["steward", steward], ["stranger", stranger]]) {
    wallets[name] = createWalletClient({ account: addr, chain, transport: http(RPC) });
  }
});

describe("the bond", () => {
  test("the first report is always free", async () => {
    const { z } = await world();
    assert.equal(await read(z, "bondFor", [reporter, LABEL]), 0n);
  });

  test("the second report costs the base bond", async () => {
    const { z } = await world();
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    assert.equal(await read(z, "bondFor", [reporter, LABEL]), BASE_BOND);
  });

  test("a tier read from ENS discounts, then waives, the bond", async () => {
    const { z, ens } = await world();
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    assert.equal(await read(z, "bondFor", [reporter, LABEL]), BASE_BOND);

    await write(ens, "grantRoles", [LABEL, ROLE_TIER_1, reporter], "maintainer");
    assert.equal(await read(z, "bondFor", [reporter, LABEL]), BASE_BOND / 2n);
    assert.equal(await read(z, "tierOf", [reporter, LABEL]), 1);

    await write(ens, "grantRoles", [LABEL, ROLE_TIER_2, reporter], "maintainer");
    assert.equal(await read(z, "bondFor", [reporter, LABEL]), BASE_BOND / 4n);

    await write(ens, "grantRoles", [LABEL, ROLE_TIER_3, reporter], "maintainer");
    assert.equal(await read(z, "bondFor", [reporter, LABEL]), 0n);
    assert.equal(await read(z, "tierOf", [reporter, LABEL]), 3);
  });

  test("a nybble is a boolean: the registry rejects 0xF << 40", async () => {
    const { ens } = await world();
    await expectRevert(
      write(ens, "grantRoles", [LABEL, 0xfn << 40n, reporter], "maintainer"),
      "EACInvalidRoleBitmap",
    );
  });
});

describe("the verdict", () => {
  test("VALID refunds in full and earns a tier", async () => {
    const { z, token } = await world();
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");          // free
    const hash2 = await write(z, "submit", [REPO_ID, LABEL, keccak256(toHex("e2"))], "reporter");
    const id = hash2.logs.find((l) => l.topics.length === 4)?.topics[1];

    const before = await bal(token, reporter);
    await write(z, "resolve", [id, 1], "maintainer");                            // Valid
    assert.equal(await bal(token, reporter) - before, BASE_BOND, "bond refunded");
    assert.equal(await read(z, "earnedTier", [reporter]), 1);
    assert.equal(await read(z, "triagePool"), 0n);
  });

  test("GOOD FAITH refunds in full and earns nothing — being wrong is not slop", async () => {
    const { z, token } = await world();
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    const r = await write(z, "submit", [REPO_ID, LABEL, keccak256(toHex("e2"))], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];

    const before = await bal(token, reporter);
    await write(z, "resolve", [id, 2], "maintainer");                            // GoodFaith
    assert.equal(await bal(token, reporter) - before, BASE_BOND, "refunded in full");
    assert.equal(await read(z, "earnedTier", [reporter]), 0, "no tier for being wrong");
    assert.equal(await read(z, "triagePool"), 0n, "nothing slashed");
  });

  test("SLOP slashes to the triage pool, and the maintainer gets nothing", async () => {
    const { z, token } = await world();
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    const r = await write(z, "submit", [REPO_ID, LABEL, keccak256(toHex("e2"))], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];

    const mBefore = await bal(token, maintainer);
    const rBefore = await bal(token, reporter);
    await write(z, "resolve", [id, 3], "maintainer");                            // Slop

    assert.equal(await read(z, "triagePool"), BASE_BOND, "slashed into the pool");
    assert.equal(await bal(token, maintainer), mBefore, "the judge does not profit");
    assert.equal(await bal(token, reporter), rBefore, "the reporter is not refunded");
  });

  test("only the maintainer may resolve", async () => {
    const { z } = await world();
    const r = await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];
    await expectRevert(write(z, "resolve", [id, 1], "stranger"), "NotMaintainer");
  });
});

describe("ghosting — the half nobody else builds", () => {
  test("cannot be claimed before the window elapses", async () => {
    const { z } = await world();
    const r = await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];
    await expectRevert(write(z, "claimGhosted", [id], "reporter"), "WindowNotElapsed");
  });

  test("after the window, ANYONE can make the maintainer pay the reporter", async () => {
    const { z, token } = await world();
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");           // free
    const r = await write(z, "submit", [REPO_ID, LABEL, keccak256(toHex("e2"))], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];

    await pub.request({ method: "evm_increaseTime", params: [Number(WINDOW) + 60] });
    await pub.request({ method: "evm_mine", params: [] });

    const before = await bal(token, reporter);
    await write(z, "claimGhosted", [id], "stranger");                            // a stranger calls it
    const gained = await bal(token, reporter) - before;
    assert.equal(gained, BASE_BOND * 2n, "own bond back plus the maintainer's payout");
  });

  test("the maintainer cannot resolve after the window has closed", async () => {
    const { z } = await world();
    const r = await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];
    await pub.request({ method: "evm_increaseTime", params: [Number(WINDOW) + 60] });
    await pub.request({ method: "evm_mine", params: [] });
    await expectRevert(write(z, "resolve", [id, 1], "maintainer"), "WindowElapsed");
  });
});

describe("the triage pool", () => {
  test("a stranger cannot drain it", async () => {
    const { z } = await world();
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    const r = await write(z, "submit", [REPO_ID, LABEL, keccak256(toHex("e2"))], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];
    await write(z, "resolve", [id, 3], "maintainer");
    assert.equal(await read(z, "triagePool"), BASE_BOND);

    await expectRevert(write(z, "payReviewer", [stranger, BASE_BOND], "stranger"), "NotSteward");
    await expectRevert(write(z, "payReviewer", [maintainer, BASE_BOND], "maintainer"), "NotSteward");
  });

  test("the steward can pay a reviewer", async () => {
    const { z, token } = await world();
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    const r = await write(z, "submit", [REPO_ID, LABEL, keccak256(toHex("e2"))], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];
    await write(z, "resolve", [id, 3], "maintainer");

    const before = await bal(token, stranger);
    await write(z, "payReviewer", [stranger, BASE_BOND], "steward");
    assert.equal(await bal(token, stranger) - before, BASE_BOND);
    assert.equal(await read(z, "triagePool"), 0n);
  });
});

describe("token compatibility", () => {
  test("works with a USDT-style token that returns nothing", async () => {
    const { z, token } = await world({ tokenName: "NoReturnToken" });
    await write(z, "submit", [REPO_ID, LABEL, ARKIV_KEY], "reporter");
    const r = await write(z, "submit", [REPO_ID, LABEL, keccak256(toHex("e2"))], "reporter");
    const id = r.logs.find((l) => l.topics.length === 4)?.topics[1];
    const before = await bal(token, reporter);
    await write(z, "resolve", [id, 1], "maintainer");
    assert.equal(await bal(token, reporter) - before, BASE_BOND);
  });
});
