import { type Address, type Instruction, AccountRole } from "@solana/kit";
import { connect, type Connection } from "solana-kite";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { getTaskQueueAddressFromName } from "./helpers.js";
import { getAddMemoInstruction } from "@solana-program/memo";

// TODO: These imports all need to be removed in favor of solana-kit, codama and solana-kite
import { init as initTukTukProgram, queueTask } from "@helium/tuktuk-sdk";
import { Connection as Web3Connection, PublicKey } from "@solana/web3.js";
import { getKeypairFromFile } from "@solana-developers/helpers";

// Name of the task queue (one will be created if it doesn't exist).
// NOTE: This will cost 1 sol to create. You can recover this by deleting the queue using the tuktuk-cli
const queueName = "banana-queue";

// Path to your Solana wallet keypair file
const walletPath = "/Users/mike/.config/solana/id.json";

// Message to write in the memo
const message = "Hello TukTuk!";

// Setup connections - both solana-kite and web3.js for hybrid approach
const connection = connect("devnet");
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

// Compile instructions into a TukTuk V0 compiled transaction
const compileTuktukTransaction = (instructions: Array<Instruction>, signersSeedsBytes: Array<Array<Buffer>> = []) => {
  // Collect all unique accounts
  const accountSet = new Set<string>();
  const accountMetas: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [];

  // Add all accounts from instructions
  for (const instruction of instructions) {
    if (instruction.accounts) {
      for (const account of instruction.accounts) {
        if (!accountSet.has(account.address)) {
          accountSet.add(account.address);
          accountMetas.push({
            pubkey: new PublicKey(account.address),
            isSigner: account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER,
            isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER,
          });
        }
      }
    }
    // Add program ID
    if (!accountSet.has(instruction.programAddress)) {
      accountSet.add(instruction.programAddress);
      accountMetas.push({
        pubkey: new PublicKey(instruction.programAddress),
        isSigner: false,
        isWritable: false,
      });
    }
  }

  // Sort accounts: signers first, then writable, then readonly
  accountMetas.sort((a, b) => {
    if (a.isSigner !== b.isSigner) return b.isSigner ? 1 : -1;
    if (a.isWritable !== b.isWritable) return b.isWritable ? 1 : -1;
    return 0;
  });

  const accounts = accountMetas.map((meta) => meta.pubkey);
  const accountMap = new Map(accounts.map((key, index) => [key.toBase58(), index]));

  // Count account types
  const numRwSigners = accountMetas.filter((m) => m.isSigner && m.isWritable).length;
  const numRoSigners = accountMetas.filter((m) => m.isSigner && !m.isWritable).length;
  const numRw = accountMetas.filter((m) => !m.isSigner && m.isWritable).length;

  // Compile instructions
  const compiledInstructions = instructions.map((instruction) => {
    const programIdIndex = accountMap.get(instruction.programAddress)!;
    const accountIndices = instruction.accounts?.map((account) => accountMap.get(account.address)!) || [];

    return {
      programIdIndex,
      accounts: Buffer.from(accountIndices),
      data: Buffer.from(instruction.data || []),
    };
  });

  const transaction = {
    numRwSigners,
    numRoSigners,
    numRw,
    accounts,
    instructions: compiledInstructions,
    signerSeeds: signersSeedsBytes,
  };

  const remainingAccounts = accountMetas.map((meta) => ({
    pubkey: meta.pubkey,
    isSigner: meta.isSigner,
    isWritable: meta.isWritable,
  }));

  return { transaction, remainingAccounts };
};

const monitorTask = async (connection: Connection, task: Address): Promise<void> => {
  return new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      try {
        const taskAccount = await connection.rpc.getAccountInfo(task).send();
        if (!taskAccount.value) {
          console.log("Task completed! ✅");
          clearInterval(interval);
          resolve();
          return;
        }
        console.log("Task is still pending...");
      } catch (error) {
        console.log("Task completed! ✅");
        clearInterval(interval);
        resolve();
      }
    }, 2000);
  });
};

console.log("Using wallet:", keypair.address);
console.log("Message:", message);

const taskQueue = await getTaskQueueAddressFromName(connection, keypair, queueName);

const memoInstruction = getAddMemoInstruction({ memo: message });

console.log("Compiling instructions into a TukTuk transaction...");
const { transaction, remainingAccounts } = compileTuktukTransaction([memoInstruction], []);

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
} = await queueTaskTransaction.remainingAccounts(remainingAccounts).rpcAndKeys();

console.log("Task queued! Transaction signature:", signature);
console.log("Task address:", task.toBase58());

// Monitor task status
console.log("\nMonitoring task status...");
await monitorTask(connection, task.toBase58() as Address);
