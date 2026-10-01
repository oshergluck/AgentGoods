const fs=require("node:fs"),path=require("node:path");
const { ethers } = require("hardhat");
async function main(){
  const cid=Number((await ethers.provider.getNetwork()).chainId);
  const d=JSON.parse(fs.readFileSync(path.resolve(__dirname,"..","..","..","deployments",`${cid}.json`),"utf8"));
  const r=await ethers.getContractAt("AICRegistry", d.contracts.registry.proxy);
  const w=Number(await r.holdingWindowSeconds());
  console.log("chain", cid);
  console.log("holdingWindowSeconds =", w, "=", (w/3600).toFixed(1), "hours =", (w/86400).toFixed(1), "days");
  console.log("run length           = 240 minutes = 4.0 hours");
  console.log(w > 240*60
    ? "=> the window is LONGER than the whole run: every holder's first buy falls inside it, so every weight is ZERO and no dividend can ever be claimed."
    : "=> dividends are reachable within a run.");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
