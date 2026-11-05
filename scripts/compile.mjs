/* Compile the contracts with solc-js. No Foundry, no Hardhat — one dependency,
   no native toolchain, which matters on Windows the night before a deadline.
   Writes artifacts to build/ as { abi, bytecode } per contract. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "contracts");
const OUT = path.join(ROOT, "build");

function collect(dir, base = "") {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, collect(path.join(dir, e.name), rel));
    else if (e.name.endsWith(".sol")) out[rel] = { content: fs.readFileSync(path.join(dir, e.name), "utf8") };
  }
  return out;
}

const sources = collect(SRC);
console.log("solc", solc.version());
console.log("sources:", Object.keys(sources).join(", "));

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

let errors = 0;
for (const e of output.errors || []) {
  if (e.severity === "error") { errors++; console.error("\n" + e.formattedMessage); }
  else if (!/SPDX|Unused|visibility|pragma/i.test(e.formattedMessage || "")) {
    console.warn("warn:", (e.formattedMessage || "").split("\n")[0]);
  }
}
if (errors) { console.error(`\n${errors} error(s) — nothing written.`); process.exit(1); }

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
for (const [file, contracts] of Object.entries(output.contracts || {})) {
  for (const [name, c] of Object.entries(contracts)) {
    fs.writeFileSync(
      path.join(OUT, `${name}.json`),
      JSON.stringify({
        contractName: name,
        sourceName: file,
        abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
        deployedBytecode: "0x" + c.evm.deployedBytecode.object,
      }, null, 2),
    );
    const size = c.evm.deployedBytecode.object.length / 2;
    console.log(`  ${name.padEnd(20)} ${String(size).padStart(6)} bytes${size > 24576 ? "  OVER EIP-170 LIMIT" : ""}`);
    n++;
  }
}
console.log(`\ncompiled ${n} contract(s) -> build/`);
