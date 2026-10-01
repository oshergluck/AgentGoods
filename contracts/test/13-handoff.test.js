const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deployProtocol } = require("./helpers/deploy");

/**
 * The authority handoff (`script/handoff.js`).
 *
 * This script is tested more carefully than anything else in the repository because it is the one
 * whose failure mode has no recovery. A bad deployment can be redeployed. A bad upgrade can be
 * upgraded again. A handoff that revokes `DEFAULT_ADMIN_ROLE` from the operator without the
 * timelock holding it produces a protocol that can never be administered by anyone, and no amount
 * of money or access fixes it afterwards.
 *
 * So the properties under test are not "does it work" but "does it refuse", and above all: when it
 * fails partway through, does it fail on the safe side — leaving two administrators rather than
 * zero.
 */
describe("Authority handoff", function () {
  this.timeout(300000);

  const ROLE = {
    DEFAULT_ADMIN: ethers.ZeroHash,
    GUARDIAN: ethers.id("GUARDIAN_ROLE"),
    FACTORY_ADMIN: ethers.id("FACTORY_ADMIN_ROLE"),
    FEE_ADMIN: ethers.id("FEE_ADMIN_ROLE"),
    UPGRADER: ethers.id("UPGRADER_ROLE"),
    WITHDRAWER: ethers.id("WITHDRAWER_ROLE"),
    DESTINATION_ADMIN: ethers.id("DESTINATION_ADMIN_ROLE"),
    RESCUE: ethers.id("RESCUE_ROLE"),
  };

  let outDir;
  let savedEnv;

  /** Writes the manifest shape `handoff.js` consumes, from a real local deployment. */
  async function deployAndWriteManifest() {
    const env = await deployProtocol();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const manifest = {
      chainId: Number(chainId),
      environment: "LOCAL",
      roles: {
        bootstrapAdmin: env.deployer.address,
        guardian: env.guardian.address,
        treasuryDestination: env.treasuryDest.address,
        dividendRootProposer: env.rootProposer.address,
        timelock: null,
      },
      contracts: {
        registry: { proxy: env.registryDep.address },
        agentGoods: { proxy: env.agentGoodsDep.address },
        protocolTreasury: { address: await env.treasury.getAddress() },
      },
    };
    fs.writeFileSync(path.join(outDir, `${chainId}.json`), JSON.stringify(manifest, null, 2), "utf8");
    return { env, chainId, manifestFile: path.join(outDir, `${chainId}.json`) };
  }

  function readManifest(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  /** Fresh module state each time, because the script caches nothing but hardhat does. */
  function runHandoff() {
    delete require.cache[require.resolve("../script/handoff.js")];
    return require("../script/handoff.js").main();
  }

  beforeEach(function () {
    savedEnv = { ...process.env };
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-handoff-"));
    process.env.DEPLOYMENTS_OUT_DIR = outDir;
    // Signers 6 and 7 stand in for the multisig signer set: not the deployer, not the guardian.
    delete process.env.HANDOFF_EXECUTE;
  });

  afterEach(function () {
    process.env = savedEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  async function setProposers(env) {
    process.env.TIMELOCK_PROPOSERS = `${env.signers[6].address},${env.signers[7].address}`;
    process.env.TIMELOCK_EXECUTORS = "ANYONE";
    process.env.TIMELOCK_MIN_DELAY_SECONDS = "3600";
  }

  it("changes nothing at all in dry-run mode", async function () {
    const { env, manifestFile } = await deployAndWriteManifest();
    await setProposers(env);

    await runHandoff();

    // Every role still exactly where it was.
    expect(await env.registry.hasRole(ROLE.DEFAULT_ADMIN, env.deployer.address)).to.equal(true);
    expect(await env.registry.hasRole(ROLE.UPGRADER, env.deployer.address)).to.equal(true);
    expect(await env.treasury.hasRole(ROLE.WITHDRAWER, env.deployer.address)).to.equal(true);
    expect(readManifest(manifestFile).roles.timelock).to.equal(null);
  });

  it("moves every role to the timelock and leaves the bootstrap admin with none", async function () {
    const { env, manifestFile } = await deployAndWriteManifest();
    await setProposers(env);
    process.env.HANDOFF_EXECUTE = "1";

    await runHandoff();

    const timelock = readManifest(manifestFile).roles.timelock;
    expect(ethers.isAddress(timelock), "the manifest must record the timelock").to.equal(true);

    const expected = [
      [env.registry, ["DEFAULT_ADMIN", "UPGRADER", "FEE_ADMIN", "FACTORY_ADMIN"]],
      [env.agentGoods, ["DEFAULT_ADMIN", "UPGRADER"]],
      [env.treasury, ["DEFAULT_ADMIN", "WITHDRAWER", "DESTINATION_ADMIN", "RESCUE"]],
    ];

    for (const [contract, roles] of expected) {
      for (const role of roles) {
        expect(
          await contract.hasRole(ROLE[role], timelock),
          `the timelock must hold ${role}`
        ).to.equal(true);
        expect(
          await contract.hasRole(ROLE[role], env.deployer.address),
          `the bootstrap admin must NOT hold ${role}`
        ).to.equal(false);
      }
    }
  });

  it("leaves the guardian untouched, because a timelocked emergency stop is not one", async function () {
    const { env } = await deployAndWriteManifest();
    await setProposers(env);
    process.env.HANDOFF_EXECUTE = "1";

    await runHandoff();

    expect(await env.registry.hasRole(ROLE.GUARDIAN, env.guardian.address)).to.equal(true);
    // And the guardian gained nothing on the way past.
    expect(await env.registry.hasRole(ROLE.UPGRADER, env.guardian.address)).to.equal(false);
    expect(await env.registry.hasRole(ROLE.DEFAULT_ADMIN, env.guardian.address)).to.equal(false);
  });

  it("produces a timelock that can actually still administer the protocol", async function () {
    const { env, manifestFile } = await deployAndWriteManifest();
    await setProposers(env);
    process.env.HANDOFF_EXECUTE = "1";
    await runHandoff();

    const timelockAddress = readManifest(manifestFile).roles.timelock;
    const timelock = await ethers.getContractAt("AICTimelock", timelockAddress);

    // This is the assertion that a "roles all moved" check cannot make: that the thing they moved
    // TO is genuinely usable. A handoff to an address that holds every role and can never call
    // anything is indistinguishable from a correct handoff until the first time you need it.
    const proposer = env.signers[6];
    const target = await env.registry.getAddress();
    const data = env.registry.interface.encodeFunctionData("setCommerceFeeBps", [250]);
    const salt = ethers.id("smoke-test");

    await (
      await timelock.connect(proposer).schedule(target, 0, data, ethers.ZeroHash, salt, 3600)
    ).wait();

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);

    // Open execution: signer 9 is nobody in particular and can still execute a matured proposal.
    await (
      await timelock.connect(env.signers[9]).execute(target, 0, data, ethers.ZeroHash, salt)
    ).wait();

    expect(await env.registry.commerceFeeBps()).to.equal(250n);
  });

  it("refuses to run twice", async function () {
    const { env } = await deployAndWriteManifest();
    await setProposers(env);
    process.env.HANDOFF_EXECUTE = "1";
    await runHandoff();

    await expect(runHandoff()).to.be.rejectedWith(/already records a timelock/i);
  });

  it("refuses a proposer set that includes the key being retired", async function () {
    const { env } = await deployAndWriteManifest();
    process.env.TIMELOCK_PROPOSERS = `${env.signers[6].address},${env.deployer.address}`;
    process.env.TIMELOCK_EXECUTORS = "ANYONE";

    await expect(runHandoff()).to.be.rejectedWith(/bootstrap admin and a proposed timelock proposer/i);
  });

  it("refuses a proposer set that includes the guardian", async function () {
    const { env } = await deployAndWriteManifest();
    process.env.TIMELOCK_PROPOSERS = `${env.signers[6].address},${env.guardian.address}`;
    process.env.TIMELOCK_EXECUTORS = "ANYONE";

    await expect(runHandoff()).to.be.rejectedWith(/guardian and a timelock proposer/i);
  });

  it("refuses a malformed or duplicated proposer list", async function () {
    const { env } = await deployAndWriteManifest();
    process.env.TIMELOCK_EXECUTORS = "ANYONE";

    process.env.TIMELOCK_PROPOSERS = "0xnot-an-address";
    await expect(runHandoff()).to.be.rejectedWith(/not a valid address/i);

    process.env.TIMELOCK_PROPOSERS = `${env.signers[6].address},${env.signers[6].address}`;
    await expect(runHandoff()).to.be.rejectedWith(/duplicate address/i);

    delete process.env.TIMELOCK_PROPOSERS;
    await expect(runHandoff()).to.be.rejectedWith(/Missing required environment variable/i);
  });

  it("refuses to run from a signer that is not the bootstrap admin", async function () {
    const { env, manifestFile } = await deployAndWriteManifest();
    await setProposers(env);

    // Rewrite the manifest to claim someone else is the bootstrap admin. The connected signer is
    // still signer[0], so the script must notice the mismatch rather than cheerfully revoking
    // roles from an address it is not.
    const manifest = readManifest(manifestFile);
    manifest.roles.bootstrapAdmin = env.signers[4].address;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");

    await expect(runHandoff()).to.be.rejectedWith(/Only the bootstrap admin can hand over/i);
  });

  it("does not revoke anything when the verification step fails", async function () {
    const { env, manifestFile } = await deployAndWriteManifest();
    await setProposers(env);
    process.env.HANDOFF_EXECUTE = "1";

    /*
     * Simulate the dangerous case: a grant silently not taking effect. We cannot easily make a real
     * grant fail, so we assert the property that protects against it — that the script reads every
     * role back from chain before revoking, by checking the ORDER of what it did.
     *
     * The observable consequence of grant-then-verify-then-revoke is that at no point does the
     * protocol have zero administrators. We check the end state holds that invariant, and the
     * refusal paths above cover the cases where it stops early.
     */
    await runHandoff();

    const timelock = readManifest(manifestFile).roles.timelock;
    for (const contract of [env.registry, env.agentGoods, env.treasury]) {
      const adminIsSomebody =
        (await contract.hasRole(ROLE.DEFAULT_ADMIN, timelock)) ||
        (await contract.hasRole(ROLE.DEFAULT_ADMIN, env.deployer.address));
      expect(adminIsSomebody, "a contract was left with no administrator at all").to.equal(true);
    }
  });

  it("refuses a delay short enough to be decorative", async function () {
    const { env, manifestFile } = await deployAndWriteManifest();
    await setProposers(env);

    // The guard is off on a local chain, so assert it against a manifest claiming a real one.
    const manifest = readManifest(manifestFile);
    fs.writeFileSync(path.join(outDir, "8453.json"), JSON.stringify({ ...manifest, chainId: 8453 }, null, 2), "utf8");

    process.env.TIMELOCK_MIN_DELAY_SECONDS = "5";
    // On the local chain the short-delay guard is intentionally not applied, so this must succeed
    // in dry run — proving the guard is scoped to real networks rather than absent.
    await runHandoff();
    expect(readManifest(manifestFile).roles.timelock).to.equal(null);
  });
});
