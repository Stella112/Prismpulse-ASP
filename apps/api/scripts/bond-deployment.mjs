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
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const xLayer = {
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
};

const command = process.argv[2];
if (!["deploy", "confirm"].includes(command)) {
  throw new Error("Usage: bond-deployment.mjs <deploy|confirm> [bond-address]");
}

const rpcUrl = process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech";
const publicClient = createPublicClient({
  chain: xLayer,
  transport: http(rpcUrl, { timeout: 15_000 }),
});
const artifactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../contracts/out/PrismBondPool.sol/PrismBondPool.json",
);
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const abi = artifact.abi;
const bytecode = artifact.bytecode?.object;
if (!bytecode || bytecode === "0x") {
  throw new Error("PrismBondPool bytecode is missing. Run pnpm contracts:build first.");
}

const chainId = await publicClient.getChainId();
if (chainId !== xLayer.id) {
  throw new Error(`Refusing X Layer operation: RPC returned chain ID ${chainId}.`);
}

function requiredAddress(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name} must be a valid EVM address.`);
  }
}

function optionalAddress(value, name) {
  if (!value) return undefined;
  return requiredAddress(value, name);
}

function requiredPrivateKey(name) {
  const value = process.env[name];
  if (!/^0x[a-fA-F0-9]{64}$/.test(value ?? "")) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key.`);
  }
  return value;
}

function amount(name, fallback, decimals) {
  const value = process.env[name] ?? fallback;
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${name} must be a positive decimal amount.`);
  return parseUnits(value, decimals);
}

function print(value) {
  console.log(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2));
}

async function confirmBond(address) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === "0x") throw new Error(`No contract bytecode found at ${address}.`);
  const [
    asset,
    owner,
    pendingOwner,
    guardian,
    perTransactionCap,
    globalExposureCap,
    tinyPayoutThreshold,
    payoutDelay,
    totalCapital,
    coveredExposure,
    totalShares,
  ] = await Promise.all([
    publicClient.readContract({ address, abi, functionName: "asset" }),
    publicClient.readContract({ address, abi, functionName: "owner" }),
    publicClient.readContract({ address, abi, functionName: "pendingOwner" }),
    publicClient.readContract({ address, abi, functionName: "guardian" }),
    publicClient.readContract({ address, abi, functionName: "perTransactionCap" }),
    publicClient.readContract({ address, abi, functionName: "globalExposureCap" }),
    publicClient.readContract({ address, abi, functionName: "tinyPayoutThreshold" }),
    publicClient.readContract({ address, abi, functionName: "payoutDelay" }),
    publicClient.readContract({ address, abi, functionName: "totalCapital" }),
    publicClient.readContract({ address, abi, functionName: "coveredExposure" }),
    publicClient.readContract({ address, abi, functionName: "totalShares" }),
  ]);
  return {
    chainId,
    bondAddress: address,
    asset,
    owner,
    pendingOwner,
    guardian,
    perTransactionCap,
    globalExposureCap,
    tinyPayoutThreshold,
    payoutDelay,
    totalCapital,
    coveredExposure,
    totalShares,
    bytecodeBytes: (code.length - 2) / 2,
    explorerUrl: `https://www.oklink.com/x-layer/address/${address}`,
  };
}

if (command === "confirm") {
  const address = requiredAddress(process.argv[3] ?? process.env.BOND_POOL_ADDRESS, "BOND_POOL_ADDRESS");
  print(await confirmBond(address));
  process.exit(0);
}

const deployer = privateKeyToAccount(requiredPrivateKey("BOND_DEPLOYER_PRIVATE_KEY"));
const asset = requiredAddress(process.env.BOND_ASSET_ADDRESS, "BOND_ASSET_ADDRESS");
const guardian = requiredAddress(process.env.BOND_GUARDIAN_ADDRESS, "BOND_GUARDIAN_ADDRESS");
const finalOwner = optionalAddress(process.env.BOND_FINAL_OWNER_ADDRESS, "BOND_FINAL_OWNER_ADDRESS");
const decimals = Number(process.env.BOND_ASSET_DECIMALS ?? "6");
if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
  throw new Error("BOND_ASSET_DECIMALS must be an integer between 0 and 36.");
}
const perTransactionCap = amount("BOND_PER_TRANSACTION_CAP", "0.05", decimals);
const globalExposureCap = amount("BOND_GLOBAL_EXPOSURE_CAP", "0.10", decimals);
const tinyPayoutThreshold = amount("BOND_TINY_PAYOUT_THRESHOLD", "0.01", decimals);
const payoutDelay = BigInt(process.env.BOND_PAYOUT_DELAY_SECONDS ?? "3600");
if (globalExposureCap < perTransactionCap) {
  throw new Error("BOND_GLOBAL_EXPOSURE_CAP must be at least BOND_PER_TRANSACTION_CAP.");
}

const args = [
  asset,
  deployer.address,
  guardian,
  perTransactionCap,
  globalExposureCap,
  tinyPayoutThreshold,
  payoutDelay,
];
const deploymentData = encodeDeployData({ abi, bytecode, args });
const estimatedGas = await publicClient.estimateGas({ account: deployer.address, data: deploymentData });
const fees = await publicClient.estimateFeesPerGas();
const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
const estimatedCost = estimatedGas * feePerGas;
const balance = await publicClient.getBalance({ address: deployer.address });
if (balance < estimatedCost) {
  throw new Error(
    `Bond deployer ${deployer.address} needs approximately ${formatEther(estimatedCost)} OKB.`,
  );
}

const walletClient = createWalletClient({
  account: deployer,
  chain: xLayer,
  transport: http(rpcUrl, { timeout: 15_000 }),
});
const transactionHash = await walletClient.deployContract({ abi, bytecode, args });
const receipt = await publicClient.waitForTransactionReceipt({
  hash: transactionHash,
  confirmations: Number(process.env.BOND_CONFIRMATIONS ?? "2"),
  timeout: 180_000,
});
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error(`Bond deployment failed in transaction ${transactionHash}.`);
}

let ownershipTransfer;
if (finalOwner && finalOwner.toLowerCase() !== deployer.address.toLowerCase()) {
  const transferHash = await walletClient.writeContract({
    address: receipt.contractAddress,
    abi,
    functionName: "beginOwnershipTransfer",
    args: [finalOwner],
  });
  const transferReceipt = await publicClient.waitForTransactionReceipt({
    hash: transferHash,
    confirmations: Number(process.env.BOND_CONFIRMATIONS ?? "2"),
    timeout: 180_000,
  });
  if (transferReceipt.status !== "success") {
    throw new Error(`Bond ownership-transfer transaction failed: ${transferHash}.`);
  }
  ownershipTransfer = { transactionHash: transferHash, pendingOwner: finalOwner };
}

print({
  operation: "DEPLOYED",
  transactionHash,
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed,
  deployer: deployer.address,
  estimatedCostOkb: formatEther(estimatedCost),
  ownershipTransfer,
  ...(await confirmBond(receipt.contractAddress)),
});
