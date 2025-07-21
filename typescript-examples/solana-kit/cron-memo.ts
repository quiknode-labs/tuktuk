import { connect } from "solana-kite";
import { 
  getTaskQueueAddressFromName, 
  getCronJobForName
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

// Amount of SOL to fund the cron job with (default: 0.01 SOL)
const fundingAmount = 0.01;

// Load wallet and connection
const connection = connect("devnet");
const keypair = await connection.loadWalletFromFile(walletPath);

console.log("Using wallet:", keypair.address);
console.log("Message:", message);

// Get the task queue address
const taskQueue = await getTaskQueueAddressFromName(connection, keypair, queueName);

// Check if cron job already exists
let cronJob = await getCronJobForName(connection, cronName);

if (!cronJob) {
  console.log("Cron job not found. Use the web3js-legacy version to create cron jobs first.");
  console.log("Run: cd ../web3js-legacy && npx tsx cron-memo.ts");
  process.exit(1);
} else {
  console.log("Cron job already exists");
}

console.log("Cron job address:", cronJob);
console.log(
  `\nYour memo will be posted every minute. Watch for transactions on task queue ${taskQueue}. To stop the cron job, use the tuktuk-cli:`
);
console.log(
  `tuktuk -u https://api.devnet.solana.com -w ${walletPath} cron-transaction close --cron-name ${cronName} --id 0`
);
console.log(
  `tuktuk -u https://api.devnet.solana.com -w ${walletPath} cron close --cron-name ${cronName}`
);