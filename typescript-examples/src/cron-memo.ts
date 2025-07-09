import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  createCronJob,
  cronJobTransactionKey,
  getCronJobForName,
  init as initCron,
} from "@helium/cron-sdk";
import { compileTransaction, init } from "@helium/tuktuk-sdk";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { initializeTaskQueue, makeMemoInstruction } from "./helpers";
import { getKeypairFromFile } from "@solana-developers/helpers";
import { sendInstructions } from "@helium/spl-utils";

// Name of the cron job (must be unique)
const cronName = "my-cron-job";

// Name of the task queue to use (one will be created if it doesn't exist)
const queueName = "banana-queue";

// Path to your Solana wallet keypair file
const walletPath = "/Users/mike/.config/solana/id.json";

// Solana RPC URL (e.g., https://api.devnet.solana.com)
const rpcUrl = "https://api.devnet.solana.com";

//  Message to write in the memo
const message = "Hello TukTuk Cron!";

// Amount of SOL to fund the cron job with in lamports (default: 1 SOL)
const fundingAmount = 0.01 * LAMPORTS_PER_SOL;

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

// Initialize TukTuk program
const program = await init(provider);
const cronProgram = await initCron(provider);
const taskQueue = await initializeTaskQueue(program, queueName);

// Check if cron job already exists
let cronJob = await getCronJobForName(cronProgram, cronName);
if (!cronJob) {
  console.log("Creating new cron job...");
  const createCronJobTransaction = await createCronJob(cronProgram, {
    tuktukProgram: program,
    taskQueue,
    args: {
      name: cronName,
      schedule: "0 * * * * *", // Run every minute
      // The memo transaction doesn't need to schedule more transactions, so we set this to 0
      freeTasksPerTransaction: 0,
      // We just have one transaction to queue for each cron job, so we set this to 1
      numTasksPerQueueCall: 1,
    },
  });
  const {
    pubkeys: { cronJob: cronJobPubkey },
  } = await createCronJobTransaction.rpcAndKeys({ skipPreflight: true });
  cronJob = cronJobPubkey;
  console.log("Funding cron job with", fundingAmount / LAMPORTS_PER_SOL, "SOL");
  await sendInstructions(provider, [
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: cronJob,
      lamports: fundingAmount,
    }),
  ]);
  // Create a simple memo instruction
  const memoInstruction = makeMemoInstruction(message);

  // Compile the instruction
  console.log("Compiling instructions...");
  const { transaction, remainingAccounts } = compileTransaction(
    [memoInstruction],
    []
  );

  // Adding memo to the cron job
  await cronProgram.methods
    .addCronTransactionV0({
      index: 0,
      transactionSource: {
        compiledV0: [transaction],
      },
    })
    .accounts({
      payer: keypair.publicKey,
      cronJob,
      cronJobTransaction: cronJobTransactionKey(cronJob, 0)[0],
    })
    .remainingAccounts(remainingAccounts)
    .rpc({ skipPreflight: true });
  console.log(`Cron job created!`);
} else {
  console.log("Cron job already exists");
}

console.log("Cron job address:", cronJob.toBase58());
console.log(
  `\nYour memo will be posted every minute. Watch for transactions on task queue ${taskQueue.toBase58()}. To stop the cron job, use the tuktuk-cli:`
);
console.log(
  `tuktuk -u ${rpcUrl} -w ${walletPath} cron-transaction close --cron-name ${cronName} --id 0`
);
console.log(
  `tuktuk -u ${rpcUrl} -w ${walletPath} cron close --cron-name ${cronName}`
);
