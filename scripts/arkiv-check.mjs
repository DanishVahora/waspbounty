/* Preflight against Rabdi.
   Reads only. Confirms the access key works, the chain is the one we think it
   is, and reports the dev EOA balance so we know whether writes can proceed.

   Transport errors are sanitized: the access key is encoded into the RPC URL by
   the SDK, so a raw error can leak it into a log. */

import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RABDI_CHAIN_ID = 7794095;

const accessKey = process.env.ARKIV_ACCESS_KEY;
if (!accessKey) {
  console.error("ARKIV_ACCESS_KEY missing from .env");
  process.exit(1);
}

/* never let a keyed URL reach a log */
const scrub = (e) =>
  String(e?.shortMessage || e?.message || e)
    .replace(/ark_live_[A-Za-z0-9_-]+/g, "ark_live_<redacted>")
    .replace(/https?:\/\/[^\s)]+/g, "<rpc-url-redacted>")
    .split("\n")[0]
    .slice(0, 200);

const chain = rabdi({ accessKey });
const transport = http(undefined, { retryCount: 1, timeout: 15000 });
const reader = createPublicClient({ chain, transport, cacheTime: 0 });

try {
  const [chainId, block, gasPrice] = await Promise.all([
    reader.getChainId(),
    reader.getBlockNumber(),
    reader.getGasPrice(),
  ]);

  console.log("Arkiv / Rabdi preflight");
  console.log("  access key :", accessKey.slice(0, 9) + "…" + accessKey.slice(-4), "(accepted)");
  console.log("  chain id   :", chainId, chainId === RABDI_CHAIN_ID ? "OK" : `WRONG — expected ${RABDI_CHAIN_ID}`);
  console.log("  block      :", block.toString());
  console.log("  gas price  :", gasPrice.toString(), "wei");

  if (chainId !== RABDI_CHAIN_ID) process.exit(1);

  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (pk) {
    const account = privateKeyToAccount(pk);
    const bal = await reader.getBalance({ address: account.address });
    console.log("  dev EOA    :", account.address);
    console.log("  balance    :", formatEther(bal), "tGLM", bal === 0n ? "<- NEEDS FAUCET before any write" : "OK");
  }
} catch (e) {
  console.error("preflight FAILED:", scrub(e));
  process.exit(1);
}
