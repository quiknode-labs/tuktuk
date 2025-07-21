import { type Address, type Instruction, AccountRole, type TransactionSigner } from "@solana/kit";
import { connect, type Connection } from "solana-kite";
import { getTaskQueueAddressFromName } from "./helpers.js";
import { getAddMemoInstruction } from "@solana-program/memo";
import { getQueueTaskV0InstructionAsync } from "./dist/js-client/index.js";

// Minimal imports needed for PDA derivation only
import { taskKey } from "@helium/tuktuk-sdk";

// Name of the task queue (one will be created if it doesn't exist).
// NOTE: This will cost 1 sol to create. You can recover this by deleting the queue using the tuktuk-cli
const queueName = "banana-queue";

// Path to your Solana wallet keypair file
const walletPath = "/Users/mike/.config/solana/id.json";

// Message to write in the memo
const message = "Hello TukTuk!";

// Setup connection using solana-kite
const connection = connect("devnet");
const keypair = await connection.loadWalletFromFile(walletPath);

// Helper function to find next available task ID from bitmap
const nextAvailableTaskId = (taskBitmap: Uint8Array): number | null => {
  for (let byteIdx = 0; byteIdx < taskBitmap.length; byteIdx++) {
    const byte = taskBitmap[byteIdx];
    if (byte !== 0xff) { // If byte is not all 1s
      for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
        if ((byte & (1 << bitIdx)) === 0) {
          return byteIdx * 8 + bitIdx;
        }
      }
    }
  }
  return null;
};

// TaskQueueV0 account structure offsets (based on Rust struct)
const TASK_QUEUE_V0_OFFSETS = {
  TUKTUK_CONFIG: 8, // Skip discriminator
  ID: 40,
  UPDATE_AUTHORITY: 44,
  RESERVED: 76,
  MIN_CRANK_REWARD: 108,
  UNCOLLECTED_PROTOCOL_FEES: 116,
  CAPACITY: 124,
  CREATED_AT: 126,
  UPDATED_AT: 134,
  BUMP_SEED: 142,
  TASK_BITMAP_LEN: 143, // u32 length prefix for Vec<u8>
  TASK_BITMAP: 147, // Start of bitmap data
};

// Parse TaskQueueV0 account data to extract task bitmap
const parseTaskQueueV0 = (accountData: Uint8Array) => {
  const capacity = new DataView(accountData.buffer, accountData.byteOffset).getUint16(TASK_QUEUE_V0_OFFSETS.CAPACITY, true);
  const bitmapLen = new DataView(accountData.buffer, accountData.byteOffset).getUint32(TASK_QUEUE_V0_OFFSETS.TASK_BITMAP_LEN, true);
  const taskBitmap = accountData.slice(TASK_QUEUE_V0_OFFSETS.TASK_BITMAP, TASK_QUEUE_V0_OFFSETS.TASK_BITMAP + bitmapLen);
  
  return { capacity, taskBitmap };
};

// Modern queueTask replacement using Solana Kit/Kite/Codama
const queueTaskModern = async (
  connection: Connection,
  signer: TransactionSigner,
  taskQueue: Address,
  args: {
    trigger: { __kind: 'Now' } | { __kind: 'Timestamp', fields: [bigint] };
    transaction: { __kind: 'CompiledV0', fields: [any] };
    crankReward: bigint | null;
    freeTasks: number;
    description: string;
  }
) => {
  // 1. Fetch task queue account to get task bitmap
  const taskQueueAccount = await connection.rpc.getAccountInfo(taskQueue, {
    encoding: 'base64'
  }).send();
  if (!taskQueueAccount.value) {
    throw new Error('Task queue account not found');
  }

  // 2. Parse task bitmap and find available task ID
  let accountData: Uint8Array;
  if (Array.isArray(taskQueueAccount.value.data) && taskQueueAccount.value.data.length === 2) {
    // Account data is [Base64EncodedBytes, "base64"] format
    accountData = new Uint8Array(Buffer.from(taskQueueAccount.value.data[0] as string, 'base64'));
  } else if (typeof taskQueueAccount.value.data === 'string') {
    // Account data is base64 encoded string
    accountData = new Uint8Array(Buffer.from(taskQueueAccount.value.data, 'base64'));
  } else {
    // Already a Uint8Array or other format
    accountData = new Uint8Array(taskQueueAccount.value.data as any);
  }

  const { taskBitmap } = parseTaskQueueV0(accountData);
  const taskId = nextAvailableTaskId(taskBitmap);
  if (taskId === null) {
    throw new Error('No available task slots in queue');
  }

  // 3. Derive task PDA using the imported taskKey function
  // Convert Address to PublicKey for taskKey function
  const { PublicKey } = await import("@solana/web3.js");
  const taskQueuePubkey = new PublicKey(taskQueue);
  const [taskPDA] = taskKey(taskQueuePubkey, taskId);
  const taskAddress = taskPDA.toBase58() as Address;

  // 4. Create queue task instruction
  const instruction = await getQueueTaskV0InstructionAsync({
    payer: signer,
    queueAuthority: signer,
    taskQueue,
    task: taskAddress,
    id: taskId,
    ...args,
  });

  // 5. Send transaction using connection.sendTransactionFromInstructions
  const signature = await connection.sendTransactionFromInstructions({
    feePayer: signer as any, // Type assertion for compatibility
    instructions: [instruction],
  });

  return {
    signature,
    taskId,
    taskAddress,
  };
};

// Compile instructions into a TukTuk V0 compiled transaction
const compileTuktukTransaction = (instructions: Array<Instruction>, signersSeedsBytes: Array<Array<Buffer>> = []) => {
  // Collect all unique accounts
  const accountSet = new Set<string>();
  const accountMetas: Array<{ address: string; isSigner: boolean; isWritable: boolean }> = [];

  // Add all accounts from instructions
  for (const instruction of instructions) {
    if (instruction.accounts) {
      for (const account of instruction.accounts) {
        if (!accountSet.has(account.address)) {
          accountSet.add(account.address);
          accountMetas.push({
            address: account.address,
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
        address: instruction.programAddress,
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

  const accounts = accountMetas.map((meta) => meta.address);
  const accountMap = new Map(accounts.map((address, index) => [address, index]));

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

  return transaction;
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
const transaction = compileTuktukTransaction([memoInstruction], []);

// Queue the task using modern implementation
console.log("Queueing task...");

const { signature, taskId, taskAddress } = await queueTaskModern(
  connection,
  keypair,
  taskQueue,
  {
    trigger: { __kind: 'Now' as const },
    transaction: {
      __kind: 'CompiledV0' as const,
      fields: [transaction],
    },
    crankReward: null,
    freeTasks: 0,
    description: `memo: ${message}`,
  }
);

console.log("Task queued! Transaction signature:", signature);
console.log("Task ID:", taskId);
console.log("Task address:", taskAddress);

// Monitor task status
console.log("\nMonitoring task status...");
await monitorTask(connection, taskAddress);
