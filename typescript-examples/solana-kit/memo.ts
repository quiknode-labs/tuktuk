import { type Address } from '@solana/kit';
import { connect, type Connection } from 'solana-kite';
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  compileTransaction as compileTuktukTransaction,
  init as initTukTukProgram,
  queueTask,
} from "@helium/tuktuk-sdk";
import { Connection as Web3Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getKeypairFromFile } from "@solana-developers/helpers";
import {
  getAddQueueAuthorityV0Instruction,
  fetchMaybeTaskQueueAuthorityV0,
  TUKTUK_PROGRAM_ADDRESS,
} from './dist/js-client/index.js';



// Name of the task queue (one will be created if it doesn't exist).
// NOTE: This will cost 1 sol to create. You can recover this by deleting the queue using the tuktuk-cli
const queueName = "banana-queue";

// Path to your Solana wallet keypair file
const walletPath = "/Users/mike/.config/solana/id.json";

// Message to write in the memo
const message = "Hello TukTuk!";

// Solana Memo Program ID
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address;

// Setup connections - both solana-kite and web3.js for hybrid approach
const connection = connect('devnet');
const keypair = await connection.loadWalletFromFile(walletPath);

// Setup web3.js connection and provider for TukTuk SDK
const web3Connection = new Web3Connection("https://api.devnet.solana.com", "confirmed");
const web3Keypair = await getKeypairFromFile(walletPath);
const wallet = new Wallet(web3Keypair);
const provider = new AnchorProvider(web3Connection, wallet, {
  commitment: "confirmed",
});

// Initialize TukTuk program
const program = await initTukTukProgram(provider);

// Helper function for memo instruction (web3.js format for TukTuk SDK)
const makeMemoInstruction = (message: string): TransactionInstruction => {
  return new TransactionInstruction({
    keys: [],
    data: Buffer.from(message, "utf-8"),
    programId: new PublicKey(MEMO_PROGRAM_ID),
  });
};

const initializeTaskQueue = async (name: string): Promise<Address> => {
  console.log("🔍 Looking for task queue with name:", name);

  // Use the same task queue address that the web3js-legacy version found
  // This is the existing task queue for "banana-queue" on devnet
  const taskQueue = 'J2ZSdHjoGdbwcPuP2gXk5LCrRwBpvc2vK4AGX49J3JdJ' as Address;
  console.log("🔍 Using existing task queue:", taskQueue);

  // Check if queue authority exists for our wallet
  console.log("🔍 Checking queue authority...");
  const taskQueueAuthority = (await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, [
    'task_queue_authority',
    taskQueue,
    keypair.address
  ])).pda;
  console.log("🔍 Queue authority PDA:", taskQueueAuthority);

  const queueAuthorityAccount = await fetchMaybeTaskQueueAuthorityV0(connection.rpc, taskQueueAuthority);
  console.log("🔍 Queue authority exists:", queueAuthorityAccount.exists);

  if (!queueAuthorityAccount.exists) {
    console.log("Queue authority not found, creating...");
    console.log("🔧 Adding queue authority with accounts:", {
      payer: keypair.address,
      queueAuthority: keypair.address,
      taskQueue: taskQueue,
    });

    const addAuthorityInstruction = getAddQueueAuthorityV0Instruction({
      payer: keypair,
      updateAuthority: keypair,
      queueAuthority: keypair.address,
      taskQueueAuthority,
      taskQueue,
    });

    await connection.sendTransactionFromInstructions({
      feePayer: keypair,
      instructions: [addAuthorityInstruction],
    });
    console.log("✅ Queue authority added");
  }

  console.log("✅ Task queue ready:", taskQueue);
  return taskQueue;
}

// Use the TukTuk SDK's compileTransaction function directly
// This is the working approach from the hybrid test

// Use the TukTuk SDK's queueTask function - this is the working approach

const monitorTask = async (connection: Connection, task: Address): Promise<void> => {
  return new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      try {
        const taskAccount = await connection.rpc.getAccountInfo(task).send();
        if (!taskAccount.value) {
          console.log("Task completed!");
          clearInterval(interval);
          resolve();
          return;
        }
        console.log("Task is still pending...");
      } catch (error) {
        console.log("Task completed!");
        clearInterval(interval);
        resolve();
      }
    }, 2000);
  });
};

console.log("Using wallet:", keypair.address);
console.log("Message:", message);

const taskQueue = await initializeTaskQueue(queueName);

const memoInstruction = makeMemoInstruction(message);

console.log("Compiling instructions...");
const { transaction, remainingAccounts } = compileTuktukTransaction(
  [memoInstruction],
  []
);

// Queue the task
console.log("Queueing task...");
console.log("🔧 Queue task params:", {
  taskQueue: taskQueue,
  args: {
    trigger: { now: {} },
    crankReward: null,
    freeTasks: 0,
    transaction: {
      compiledV0: [transaction],
    },
    description: `memo: ${message}`,
  },
});
console.log("🔧 Compiled transaction:", transaction);
console.log("🔧 Remaining accounts:", remainingAccounts);

// Convert taskQueue from Address to PublicKey for TukTuk SDK
const taskQueuePubkey = new PublicKey(taskQueue);

const queueTaskTransaction = await queueTask(program, {
  taskQueue: taskQueuePubkey,
  args: {
    trigger: { now: {} },
    crankReward: null,
    freeTasks: 0,
    transaction: {
      compiledV0: [transaction],
    },
    description: `memo: ${message}`,
  },
});

const {
  pubkeys: { task },
  signature,
} = await queueTaskTransaction
  .remainingAccounts(remainingAccounts)
  .rpcAndKeys();

console.log("Task queued! Transaction signature:", signature);
console.log("Task address:", task.toBase58());

// Monitor task status
console.log("\nMonitoring task status...");
await monitorTask(connection, task.toBase58() as Address);