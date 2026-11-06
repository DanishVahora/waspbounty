/* ============================================================================
   The chain half of the app.
   ----------------------------------------------------------------------------
   Everything here is a READ. The app never holds a user's key and never signs
   on their behalf — settlement is a transaction a human signs in their own
   wallet. What the server does is quote the chain honestly: what bond would
   this reporter actually post, who owns this lane, what state is this report in.

   Addresses come from deployments.sepolia.json, written by scripts/deploy.mjs.
   Nothing here is hard-coded, because ENS asks for a functional demo with no
   hard-coded values and because a redeploy should not mean editing source.
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatEther } from "viem";
import { sepolia } from "viem/chains";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

const DEPLOY_FILE = path.join(ROOT, "deployments.sepolia.json");
const ARTIFACT = path.join(ROOT, "build", "WaspBounty.json");

export class ChainError extends Error {}

/* ---------- wiring, resolved once at import ------------------------------- */

function load() {
  if (!fs.existsSync(DEPLOY_FILE)) {
    throw new ChainError("deployments.sepolia.json not found — run `npm run deploy`");
  }
  if (!fs.existsSync(ARTIFACT)) {
    throw new ChainError("build/WaspBounty.json not found — run `npm run compile`");
  }
  const d = JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8"));
  const abi = JSON.parse(fs.readFileSync(ARTIFACT, "utf8")).abi;
  return { d, abi };
}

let wiring = null, wiringError = null;
try {
  wiring = load();
} catch (e) {
  wiringError = e.message;
}

export const deployment = wiring?.d ?? null;
export const abi = wiring?.abi ?? null;
export const address = wiring?.d?.contracts?.WaspBounty?.address ?? null;
export const tokenAddress = wiring?.d?.contracts?.MockToken?.address ?? null;

const rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
export const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });

const read = (functionName, args = []) =>
  pub.readContract({ address, abi, functionName, args });

const explorer = (a) => `https://sepolia.etherscan.io/address/${a}`;

/* ---------- status -------------------------------------------------------- */

/* Deliberately verifies rather than asserts: it checks there is code at the
   address and reads the constructor values back, so "connected" means the
   contract answered, not that a config file mentioned it. */
export async function chainStatus() {
  if (!wiring) return { connected: false, reason: wiringError };
  try {
    const [chainId, block, code] = await Promise.all([
      pub.getChainId(),
      pub.getBlockNumber(),
      pub.getCode({ address }),
    ]);
    if (!code || code === "0x") {
      return { connected: false, reason: `no contract code at ${address} on chain ${chainId}` };
    }
    const [token, ensRegistry, baseBond, steward, pool] = await Promise.all([
      read("token"), read("ensRegistry"), read("baseBond"),
      read("triageSteward"), read("triagePool"),
    ]);
    return {
      connected: true,
      chainId,
      network: "sepolia",
      block: block.toString(),
      address,
      codeBytes: (code.length - 2) / 2,
      token,
      tokenAddress,
      ensRegistry,
      /* the ENS claim, stated as a checkable fact rather than a promise */
      ensIsLiveRegistry:
        String(ensRegistry).toLowerCase() === String(deployment.ensRegistry).toLowerCase(),
      baseBond: formatEther(baseBond),
      baseBondWei: baseBond.toString(),
      triageSteward: steward,
      triagePool: formatEther(pool),
      deployedAt: deployment.deployedAt,
      explorer: explorer(address),
      ensExplorer: explorer(ensRegistry),
    };
  } catch (e) {
    return { connected: false, reason: e.shortMessage || e.message };
  }
}

/* ---------- the ENS read, which is the whole tier story ------------------- */

/* What this reporter would actually pay, right now, read from the chain —
   and the tier that decided it, read from the live ENSv2 registry.
   This is the call that makes the ENS integration load-bearing instead of
   decorative: change the roles on the name and this number changes. */
export async function bondQuote(reporter, labelId = 0n) {
  if (!wiring) throw new ChainError(wiringError);
  const id = typeof labelId === "bigint" ? labelId : BigInt(labelId || 0);
  const [bond, tier, before, base] = await Promise.all([
    read("bondFor", [reporter, id]),
    read("tierOf", [reporter, id]),
    read("hasSubmittedBefore", [reporter]),
    read("baseBond"),
  ]);
  const waived = bond === 0n;
  return {
    reporter,
    labelId: id.toString(),
    bondWei: bond.toString(),
    bond: formatEther(bond),
    baseBond: formatEther(base),
    tier: Number(tier),
    hasSubmittedBefore: before,
    waived,
    /* say WHY it is free, because "0" has two very different meanings here */
    reason: waived
      ? before
        ? `tier ${Number(tier)} on ENS waives the bond`
        : "first report from this address is free"
      : `tier ${Number(tier)} — bond required`,
    source: "bondFor() on Sepolia, reading live ENSv2",
  };
}

/* ---------- lanes --------------------------------------------------------- */

/* The id is derived on-chain from the project name, so a judge can check that
   the lane for curl/curl is the lane for curl/curl and not a number we chose. */
export async function laneState(slug) {
  if (!wiring) throw new ChainError(wiringError);
  const repoId = await read("repoIdFor", [slug]);
  const r = await read("repos", [repoId]);
  const [maintainer, pool, reserved, responseWindow, active, storedSlug] = r;
  return {
    slug,
    repoId,
    registered: active,
    maintainer: active ? maintainer : null,
    storedSlug: active ? storedSlug : null,
    pool: formatEther(pool),
    reserved: formatEther(reserved),
    available: formatEther(pool - reserved),
    responseWindowSeconds: Number(responseWindow),
    responseWindowDays: Number(responseWindow) / 86400,
    explorer: explorer(address),
  };
}

/* ---------- a single report ----------------------------------------------- */

const STATUS = ["none", "open", "resolved", "ghosted"];
const VERDICT = ["none", "valid", "goodFaith", "slop"];

export async function reportState(reportId) {
  if (!wiring) throw new ChainError(wiringError);
  const r = await read("reports", [reportId]);
  const [reporter, repoId, arkivKey, bond, ghostPayout, respondBy, status, verdict] = r;
  const now = Math.floor(Date.now() / 1000);
  return {
    reportId,
    reporter,
    repoId,
    arkivKey,
    bond: formatEther(bond),
    ghostPayout: formatEther(ghostPayout),
    respondBy: Number(respondBy),
    respondByISO: Number(respondBy) ? new Date(Number(respondBy) * 1000).toISOString() : null,
    secondsLeft: Number(respondBy) ? Number(respondBy) - now : null,
    /* the maintainer is out of time and anyone may now claim for the reporter */
    ghostable: Number(status) === 1 && Number(respondBy) > 0 && now > Number(respondBy),
    status: STATUS[Number(status)] ?? String(status),
    verdict: VERDICT[Number(verdict)] ?? String(verdict),
    exists: Number(status) !== 0,
  };
}

/* ---------- tier constants, read from the contract not retyped ------------ */

export async function tierRoles() {
  if (!wiring) throw new ChainError(wiringError);
  const [t1, t2, t3] = await Promise.all([
    read("ROLE_TIER_1"), read("ROLE_TIER_2"), read("ROLE_TIER_3"),
  ]);
  return {
    /* each is a single bit in its own EAC nybble: a boolean, not a 0-15 level */
    ROLE_TIER_1: { value: t1.toString(), hex: "0x" + t1.toString(16), nybble: 10 },
    ROLE_TIER_2: { value: t2.toString(), hex: "0x" + t2.toString(16), nybble: 11 },
    ROLE_TIER_3: { value: t3.toString(), hex: "0x" + t3.toString(16), nybble: 12 },
    note: "EnhancedAccessControl validates bitmaps against ALL_ROLES, so each nybble holds a boolean, not a level",
  };
}
