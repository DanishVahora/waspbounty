/* Deploy to Sepolia.

   Two contracts go up:

     MockToken   the bond currency for the demo. Sepolia has no canonical
                 stablecoin, so we ship our own and say so plainly rather
                 than implying a real asset is at stake.

     WaspBounty  the bond contract, pointed at the REAL ENSv2 ETHRegistry on
                 Sepolia — not a mock. bondFor() therefore reads live chain
                 state when it decides whether a reporter's tier waives the
                 bond. That is the difference between claiming the ENS
                 integration works and showing it.

   Usage:  npm run deploy            deploy
           npm run deploy -- --dry   print the plan, broadcast nothing
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "..", "build");
const artifact = (n) => JSON.parse(fs.readFileSync(path.join(BUILD, `${n}.json`), "utf8"));

const DRY = process.argv.includes("--dry");

/* The live ENSv2 registry on Sepolia. Confirmed to hold code and to expose
   hasRoles(uint256,uint256,address) by scripts/ens-probe.mjs. */
const ENS_ETH_REGISTRY = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4";

/* 10 demo tokens. Low enough that the free lane stays the honest default. */
const BASE_BOND = parseEther("10");

const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) { console.error("DEPLOYER_PRIVATE_KEY missing from .env"); process.exit(1); }
const account = privateKeyToAccount(pk);

const rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });

console.log("WaspBounty -> Sepolia");
console.log("  deployer  :", account.address);

const balance = await pub.getBalance({ address: account.address });
const chainId = await pub.getChainId();
console.log("  chainId   :", chainId);
console.log("  balance   :", formatEther(balance), "ETH");
console.log("  ens registry:", ENS_ETH_REGISTRY, "(live ENSv2, not a mock)");
console.log("  base bond :", formatEther(BASE_BOND), "demo tokens");
console.log("  mode      :", DRY ? "DRY RUN" : "deploying");
console.log("");

if (chainId !== 11155111) { console.error("not Sepolia — refusing"); process.exit(1); }
if (balance === 0n) { console.error("no ETH — fund the deployer first"); process.exit(1); }

if (DRY) {
  console.log("  would deploy MockToken, then WaspBounty(token, ensRegistry, baseBond, steward)");
  process.exit(0);
}

async function deploy(name, args = []) {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  process.stdout.write(`  ${name.padEnd(12)} tx ${hash.slice(0, 14)}… `);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${name} deployment reverted`);
  console.log(`-> ${r.contractAddress}  (gas ${r.gasUsed})`);
  return { address: r.contractAddress, abi: a.abi, hash, gasUsed: r.gasUsed };
}

try {
  const token = await deploy("MockToken");
  const bounty = await deploy("WaspBounty", [
    token.address,
    ENS_ETH_REGISTRY,
    BASE_BOND,
    account.address,           // triage steward
  ]);

  console.log("");
  console.log("  READ BACK (proves the constructor landed correctly)");
  for (const fn of ["token", "ensRegistry", "baseBond", "triageSteward"]) {
    const v = await pub.readContract({ address: bounty.address, abi: bounty.abi, functionName: fn });
    console.log(`    ${fn.padEnd(14)}:`, typeof v === "bigint" ? formatEther(v) : v);
  }

  /* The point of deploying against the real registry: this call reaches live
     ENSv2 on Sepolia and comes back without reverting. */
  console.log("");
  console.log("  LIVE ENS READ — bondFor() against the real registry");
  const probe = "0x0000000000000000000000000000000000000001";
  const labelId = 0n;
  const bond = await pub.readContract({
    address: bounty.address, abi: bounty.abi, functionName: "bondFor", args: [probe, labelId],
  });
  console.log("    bondFor(unknown reporter) :", formatEther(bond), "— 0 means first report is free");

  const after = await pub.getBalance({ address: account.address });
  console.log("");
  console.log("  spent :", formatEther(balance - after), "ETH");
  console.log("  left  :", formatEther(after), "ETH");
  console.log("");
  console.log("  ADDRESSES — put these in the README");
  console.log("    MockToken  :", token.address);
  console.log("    WaspBounty :", bounty.address);
  console.log("");
  console.log("  https://sepolia.etherscan.io/address/" + bounty.address);
} catch (e) {
  console.error("\n  FAILED:", e.shortMessage || e.message);
  process.exit(1);
}
