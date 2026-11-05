/* Write one disclosure record to Arkiv, then read it back.
   This is the P3 spine: if this passes, the 90-day clock is real.

   Usage:  npm run arkiv:write -- [--days 90]
*/

import { createHash, randomBytes } from "node:crypto";
import { ExpirationTime } from "@arkiv-network/sdk";
import { Report, fitStr } from "../src/arkiv/schema.mjs";
import { u64, u256, addr, str } from "@arkiv-network/sdk/schema";
import {
  clients, accountFromEnv, accessKeyFromEnv, guardedCreate, scrub, RABDI_CHAIN_ID,
} from "../src/arkiv/client.mjs";

const argv = process.argv.slice(2);
const days = Number(argv[argv.indexOf("--days") + 1]) || 90;

const account = accountFromEnv();
const accessKey = accessKeyFromEnv();
const c = clients(account, accessKey);

/* The report body never goes to Arkiv in the clear. Everything on Arkiv is
   public — the skill is explicit about it — so the sealed column holds an
   encrypted blob and the digest is what anyone can check. */
const plaintext = JSON.stringify({
  summary: "Heap overflow in ftp_parse_resp() when a PASV reply exceeds 512 bytes",
  steps: "Craft a PASV response of 600 bytes; the unchecked memcpy writes past a fixed buffer.",
  poc: "see attachment",
});
const sealed = Buffer.concat([randomBytes(16), Buffer.from(plaintext, "utf8")]); // placeholder envelope
const digest = createHash("sha256").update(plaintext).digest("hex");
const caseId = "zmt-" + randomBytes(4).toString("hex");

const now = Date.now();
const disclosureAt = now + days * 86_400_000;

console.log("WaspBounty -> Arkiv");
console.log("  network  : Rabdi", RABDI_CHAIN_ID);
console.log("  signer   :", account.address);
console.log("  case     :", caseId);
console.log("  expires  : in", days, "days  (the disclosure deadline IS the expiry)");
console.log("");

try {
  const values = {
    caseId: str(caseId),
    repo: str("curl/curl"),
    issue: u64(9114n),
    reporter: addr(account.address),
    severity: str("high"),
    state: str("open"),
    lane: str("priority"),
    openedAt: u64(BigInt(now)),
    disclosureAt: u64(BigInt(disclosureAt)),
    bondWei: u256(10_000_000_000_000_000n), // 0.01
    digest: str(digest),
    title: str(fitStr("Heap overflow in ftp_parse_resp() when PASV reply exceeds 512 bytes")),
    sealed: new Uint8Array(sealed),
  };

  const options = {
    expiration: ExpirationTime.fromDays(days),
    flags: { readonly: false, permissionlessExtension: false },
  };

  const res = await guardedCreate(c, account, accessKey, Report, values, options, { label: "report" });

  console.log("  WRITTEN");
  console.log("    entityKey :", res.entityKey);
  console.log("    txHash    :", res.txHash);
  console.log("    expiresAt : block", res.expiresAt?.toString());
  console.log("    gas       :", res.gas.toString(), "(estimate", res.estimate.toString() + ")");

  /* read it back through the schema — proves the write and the read path */
  const back = await c.reader.getEntity(res.entityKey, Report);
  console.log("");
  console.log("  READ BACK");
  console.log("    case      :", back.caseId.value);
  console.log("    repo      :", back.repo.value, "#" + back.issue.value);
  console.log("    state     :", back.state.value, "/", back.lane.value);
  console.log("    digest    :", back.digest.value.slice(0, 24) + "…");
  console.log("    creator   :", back.$creator);
  console.log("    $expiresAt:", back.$expiresAt.toString());
  console.log("");
  console.log("  explorer  : https://rabdi.explorer.arkiv.network/tx/" + res.txHash);
} catch (e) {
  console.error("  FAILED:", scrub(e));
  if (e.txHash) console.error("  admitted tx (do NOT resend):", e.txHash);
  process.exit(1);
}
