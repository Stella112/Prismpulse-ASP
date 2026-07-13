import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const xLayer = {
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
};

const command = process.argv[2];
if (!["simulate", "deploy", "confirm"].includes(command)) {
  throw new Error("Usage: registry-deployment.mjs <simulate|deploy|confirm> [registry-address]");
}

const rpcUrl = process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech";
const publicClient = createPublicClient({ chain: xLayer, transport: http(rpcUrl, { timeout: 15_000 }) });
const artifactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../contracts/out/PrismSealRegistry.sol/PrismSealRegistry.json",
);
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const abi = artifact.abi;
const bytecode = artifact.bytecode?.object;
if (!bytecode || bytecode === "0x") {
  throw new Error("PrismSealRegistry bytecode is missing. Run pnpm contracts:build first.");
}

const chainId = await publicClient.getChainId();
if (chainId !== xLayer.id) {
  throw new Error(`Refusing X Layer operation: RPC returned chain ID ${chainId}.`);
}

function optionalAddress(value, name) {
  if (!value) return undefined;
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name} must be a valid EVM address.`);
  }
}

function requiredPrivateKey(name) {
  const value = process.env[name];
  if (!/^0x[a-fA-F0-9]{64}$/.test(value ?? "")) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key.`);
  }
  return value;
}

function print(value) {
  console.log(
    JSON.stringify(
      value,
      (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
      2,
    ),
  );
}

async function confirmRegistry(registryAddress, expectedOwner, expectedIssuer) {
  const code = await publicClient.getBytecode({ address: registryAddress });
  if (!code || code === "0x") throw new Error(`No contract bytecode found at ${registryAddress}.`);

  const owner = await publicClient.readContract({
    address: registryAddress,
    abi,
    functionName: "owner",
  });
  const issuerAuthorized = expectedIssuer
    ? await publicClient.readContract({
        address: registryAddress,
        abi,
        functionName: "authorizedIssuers",
        args: [expectedIssuer],
      })
    : undefined;

  if (expectedOwner && owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(`Registry owner mismatch: expected ${expectedOwner}, received ${owner}.`);
  }
  if (expectedIssuer && !issuerAuthorized) {
    throw new Error(`Registry issuer ${expectedIssuer} is not authorized.`);
  }

  return {
    chainId,
    registryAddress,
    owner,
    expectedIssuer,
    issuerAuthorized,
    bytecodeBytes: (code.length - 2) / 2,
    explorerUrl: `https://www.oklink.com/x-layer/address/${registryAddress}`,
  };
}

if (command === "confirm") {
  const registryAddress = optionalAddress(
    process.argv[3] ?? process.env.RECEIPT_ANCHOR_ADDRESS,
    "RECEIPT_ANCHOR_ADDRESS",
  );
  if (!registryAddress) throw new Error("Provide a registry address argument or RECEIPT_ANCHOR_ADDRESS.");

  const expectedOwner = optionalAddress(process.env.REGISTRY_OWNER_ADDRESS, "REGISTRY_OWNER_ADDRESS");
  const issuerFromKey = process.env.ANCHOR_ISSUER_PRIVATE_KEY
    ? privateKeyToAccount(requiredPrivateKey("ANCHOR_ISSUER_PRIVATE_KEY")).address
    : undefined;
  const expectedIssuer =
    optionalAddress(process.env.ANCHOR_ISSUER_ADDRESS, "ANCHOR_ISSUER_ADDRESS") ?? issuerFromKey;
  print(await confirmRegistry(registryAddress, expectedOwner, expectedIssuer));
  process.exit(0);
}

const deployerPrivateKey = process.env.REGISTRY_DEPLOYER_PRIVATE_KEY;
const deployerAccount = deployerPrivateKey
  ? privateKeyToAccount(requiredPrivateKey("REGISTRY_DEPLOYER_PRIVATE_KEY"))
  : undefined;
const deployerAddress =
  deployerAccount?.address ??
  optionalAddress(process.env.REGISTRY_DEPLOYER_ADDRESS, "REGISTRY_DEPLOYER_ADDRESS");
if (!deployerAddress) {
  throw new Error(
    "Set REGISTRY_DEPLOYER_ADDRESS for simulation or REGISTRY_DEPLOYER_PRIVATE_KEY for deployment.",
  );
}
const owner =
  optionalAddress(process.env.REGISTRY_OWNER_ADDRESS, "REGISTRY_OWNER_ADDRESS") ?? deployerAddress;
const issuerFromKey = process.env.ANCHOR_ISSUER_PRIVATE_KEY
  ? privateKeyToAccount(requiredPrivateKey("ANCHOR_ISSUER_PRIVATE_KEY")).address
  : undefined;
const issuer =
  optionalAddress(process.env.ANCHOR_ISSUER_ADDRESS, "ANCHOR_ISSUER_ADDRESS") ??
  issuerFromKey ??
  deployerAddress;
const deploymentData = encodeDeployData({ abi, bytecode, args: [owner, issuer] });
const estimatedGas = await publicClient.estimateGas({ account: deployerAddress, data: deploymentData });
const fees = await publicClient.estimateFeesPerGas();
const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
const estimatedCost = estimatedGas * feePerGas;
const balance = await publicClient.getBalance({ address: deployerAddress });
const simulation = {
  chainId,
  deployer: deployerAddress,
  owner,
  issuer,
  rolesShareDeployer: owner === deployerAddress || issuer === deployerAddress,
  estimatedGas,
  estimatedCostWei: estimatedCost,
  estimatedCostOkb: formatEther(estimatedCost),
  deployerBalanceWei: balance,
  deployerBalanceOkb: formatEther(balance),
  funded: balance >= estimatedCost,
};

if (command === "simulate") {
  print({ operation: "SIMULATED", broadcast: false, ...simulation });
  process.exit(0);
}
if (!simulation.funded) {
  throw new Error(
    `Deployer ${deployerAddress} needs approximately ${simulation.estimatedCostOkb} OKB for deployment.`,
  );
}

if (!deployerAccount) {
  throw new Error("REGISTRY_DEPLOYER_PRIVATE_KEY is required for deployment.");
}
const walletClient = createWalletClient({
  account: deployerAccount,
  chain: xLayer,
  transport: http(rpcUrl, { timeout: 15_000 }),
});
const transactionHash = await walletClient.deployContract({
  abi,
  bytecode,
  args: [owner, issuer],
});
const receipt = await publicClient.waitForTransactionReceipt({
  hash: transactionHash,
  confirmations: Number(process.env.REGISTRY_CONFIRMATIONS ?? "2"),
  timeout: 180_000,
});
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error(`Registry deployment failed in transaction ${transactionHash}.`);
}
const confirmation = await confirmRegistry(receipt.contractAddress, owner, issuer);
print({
  operation: "DEPLOYED",
  transactionHash,
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed,
  ...simulation,
  ...confirmation,
});
