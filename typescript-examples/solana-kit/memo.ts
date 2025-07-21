import { connect } from "solana-kite";
import { getTaskQueueAddressFromName, queueTask, compileTuktukTransaction, monitorTask } from "./helpers.js";
import { getAddMemoInstruction } from "@solana-program/memo";

// Name of the task queue (one will be created if it doesn't exist).
// NOTE: This will cost 1 sol to create. You can recover this by deleting the queue using the tuktuk-cli
const queueName = "banana-queue";

// Path to your Solana wallet keypair file
const walletPath = "/Users/mike/.config/solana/id.json";

// Message to write in the memo
const message = "Hello TukTuk!";

const connection = connect("devnet");
const keypair = await connection.loadWalletFromFile(walletPath);

console.log("Using wallet:", keypair.address);
console.log("Will write message:", message);

const taskQueue = await getTaskQueueAddressFromName(connection, keypair, queueName);

const memoInstruction = getAddMemoInstruction({ memo: message });

console.log("Compiling instructions into a TukTuk transaction...");
const compiledTukTukTransaction = compileTuktukTransaction([memoInstruction], []);

console.log("Queueing task...");

const { signature, taskId, taskAddress } = await queueTask(connection, keypair, taskQueue, {
  trigger: { __kind: "Now" as const },
  transaction: {
    __kind: "CompiledV0" as const,
    fields: [compiledTukTukTransaction],
  },
  crankReward: null,
  freeTasks: 0,
  description: `memo: ${message}`,
});

console.log("Task queued! Transaction signature:", signature);
console.log("Task ID:", taskId);
console.log("Task address:", taskAddress);

// Monitor task status
console.log("\nMonitoring task status...");
await monitorTask(connection, taskAddress);
