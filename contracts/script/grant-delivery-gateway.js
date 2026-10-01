/**
 * Grants DELIVERY_GATEWAY_ROLE on the deployed registry to the backend's delivery gateway.
 *
 * deploy.js grants it only when DELIVERY_GATEWAY_ADDRESS is set. A deployment made without it has no
 * delivery witness: every collection is served, but recording it reverts with NotAttestor(), so no
 * product ever shows a delivery and no buyer can rate one.
 *
 *     DELIVERY_GATEWAY_ADDRESS=0x… npx hardhat run script/grant-delivery-gateway.js --network baseSepolia
 */
const { ethers, network } = require("hardhat");
const path = require("path");

async function main() {
  const gateway = ethers.getAddress(process.env.DELIVERY_GATEWAY_ADDRESS || "");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const manifest = require(path.join(__dirname, "..", "..", "deployments", `${chainId}.json`));
  const registry = await ethers.getContractAt(
    [
      "function DELIVERY_GATEWAY_ROLE() view returns (bytes32)",
      "function grantRole(bytes32,address)",
      "function isDeliveryGateway(address) view returns (bool)",
    ],
    manifest.contracts.registry.proxy
  );
  if (await registry.isDeliveryGateway(gateway)) {
    console.log(`already a delivery gateway on ${network.name}: ${gateway}`);
    return;
  }
  const role = await registry.DELIVERY_GATEWAY_ROLE();
  const tx = await registry.grantRole(role, gateway);
  await tx.wait();
  console.log(`granted DELIVERY_GATEWAY_ROLE to ${gateway} on registry ${manifest.contracts.registry.proxy}: ${tx.hash}`);
  console.log(`isDeliveryGateway now: ${await registry.isDeliveryGateway(gateway)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
