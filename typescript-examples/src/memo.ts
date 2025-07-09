import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  compileTransaction,
  init as initTukTukProgram,
  queueTask,
} from "@helium/tuktuk-sdk";
import { Connection, Keypair } from "@solana/web3.js";
import {
  initializeTaskQueue,
  monitorTask,
  makeMemoInstruction,
} from "./helpers";
import { getKeypairFromFile } from "@solana-developers/helpers";

// Configuration variables
const queueName = "banana-queue";
const walletPath = "/Users/mike/.config/solana/id.json";
const rpcUrl = "https://api.devnet.solana.com";
const message = "Hello TukTuk!";

// Load wallet from file
const keypair: Keypair = await getKeypairFromFile(walletPath);

// Setup connection and provider
const connection = new Connection(rpcUrl, "confirmed");
const wallet = new Wallet(keypair);
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});

console.log("Using wallet:", wallet.publicKey.toBase58());
console.log("RPC URL:", rpcUrl);
console.log("Message:", message);

const program = await initTukTukProgram(provider);

const taskQueue = await initializeTaskQueue(program, queueName);

const memoInstruction = makeMemoInstruction(message);

console.log("Compiling instructions...");
const { transaction, remainingAccounts } = compileTransaction(
  [memoInstruction],
  []
);

// Queue the task
console.log("Queueing task...");
const {
  pubkeys: { task },
  signature,
} = await (
  await queueTask(program, {
    taskQueue,
    args: {
      trigger: { now: {} },
      crankReward: null,
      freeTasks: 0,
      transaction: {
        compiledV0: [transaction],
      },
      description: `memo: ${message}`,
    },
  })
)
  .remainingAccounts(remainingAccounts)
  .rpcAndKeys();

console.log("Task queued! Transaction signature:", signature);
console.log("Task address:", task.toBase58());

// Monitor task status
console.log("\nMonitoring task status...");
await monitorTask(connection, task);
