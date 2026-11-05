/* Hardhat is used for ONE thing here: a local EVM with unlocked funded accounts
   to test against. Compilation is done by scripts/compile.mjs with solc-js, and
   the tests themselves are plain node:test + viem — no plugins, no toolbox, no
   mocha, nothing else to go wrong the night before a deadline.

   .cjs because package.json declares "type": "module".

   Run:  npm run chain     -> JSON-RPC on 127.0.0.1:8545
         npm test          -> the suite, against that node
*/
module.exports = {
  solidity: "0.8.28",
  networks: {
    hardhat: {
      chainId: 31337,
      // deterministic, funded, unlocked accounts
      accounts: { count: 10, accountsBalance: "10000000000000000000000" },
      mining: { auto: true },
      allowUnlimitedContractSize: false,
    },
  },
  paths: {
    sources: "./contracts",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
