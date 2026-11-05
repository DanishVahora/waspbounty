/* Generate a dedicated development EOA, once.
   Testnet only. The private key is written to .env (gitignored) and is never
   printed, never logged, and never leaves this machine. */

import fs from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV = ".env";
const env = fs.readFileSync(ENV, "utf8");

if (/^DEPLOYER_PRIVATE_KEY=0x[0-9a-fA-F]{64}$/m.test(env)) {
  const pk = env.match(/^DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m)[1];
  console.log("Dev EOA already exists:", privateKeyToAccount(pk).address);
  process.exit(0);
}

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
fs.appendFileSync(ENV, `DEPLOYER_PRIVATE_KEY=${pk}\n`, "utf8");

console.log("Generated a dedicated development EOA (testnet only).");
console.log("");
console.log("  address:", account.address);
console.log("");
console.log("Fund it at:");
console.log("  tGLM  ->  https://hub.arkiv.network/faucet");
console.log("  Sepolia ETH  ->  any Sepolia faucet");
console.log("");
console.log("The private key is in .env, which is gitignored. It is not printed here.");
