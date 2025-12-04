import { connect } from "solana-kite";
import {
  getOrCreateTaskQueue,
  getCronJobForName,
  createCronJob,
  addCronTransaction,
  compileTuktukTransaction,
} from "./helpers.js";
import { getAddMemoInstruction } from "@solana-program/memo";
import { getTransferSolInstruction } from "@solana-program/system";
import type { Address } from "@solana/kit";

// Name of the cron job (must be unique)
const cronName = "my-cron-job";

// Name of the task queue to use (one will be created if it doesn't exist)
const queueName = "banana-queue";

// Path to your Solana wallet keypair file
const walletPath = "/Users/mike/.config/solana/id.json";

// Message to write in the memo
const message = "Hello TukTuk Cron!";

// Amount of SOL to fund the cron job with (in SOL)
const fundingAmount = 0.01;

// Load wallet and connection
const connection = connect("devnet");
const keypair = await connection.loadWalletFromFile(walletPath);

console.log("Using wallet:", keypair.address);
console.log("Message:", message);

// Get the task queue address
const taskQueue = await getOrCreateTaskQueue(connection, keypair, queueName);

// Check if cron job already exists
let cronJob = await getCronJobForName(connection, keypair, cronName);

if (!cronJob) {
  console.log("Cron job not found, creating...");

  // Create the cron job
  cronJob = await createCronJob(connection, keypair, taskQueue, {
    name: cronName,
    schedule: "0 * * * * *", // Run every minute
    freeTasksPerTransaction: 0, // Memo doesn't need to schedule more transactions
    numTasksPerQueueCall: 1, // Just one transaction per cron job
  });

  // Fund the cron job with SOL
  console.log(`Funding cron job with ${fundingAmount} SOL...`);
  const fundingLamports = BigInt(Math.floor(fundingAmount * 1_000_000_000));
  const transferInstruction = getTransferSolInstruction({
    source: keypair,
    destination: cronJob,
    amount: fundingLamports,
  });
  await connection.sendTransactionFromInstructions({
    feePayer: keypair,
    instructions: [transferInstruction],
  });
  console.log("✅ Cron job funded");

  // Create the memo instruction and compile it
  const memoInstruction = getAddMemoInstruction({ memo: message });
  console.log("Compiling instructions...");
  const compiledTransaction = compileTuktukTransaction([memoInstruction], []);

  // Add the transaction to the cron job
  await addCronTransaction(connection, keypair, cronJob, 0, compiledTransaction);
  console.log("✅ Cron job created!");
} else {
  console.log("Cron job already exists");
}

console.log("Cron job address:", cronJob);
console.log(
  `\nYour memo will be posted every minute. Watch for transactions on task queue ${taskQueue}. To stop the cron job, use the tuktuk-cli:`,
);
console.log(
  `tuktuk -u https://api.devnet.solana.com -w ${walletPath} cron-transaction close --cron-name ${cronName} --id 0`,
);
console.log(`tuktuk -u https://api.devnet.solana.com -w ${walletPath} cron close --cron-name ${cronName}`);
