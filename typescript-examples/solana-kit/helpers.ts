import { KeyPairSigner, type Address, type Instruction, AccountRole, type TransactionSigner } from "@solana/kit";
import { connect, type Connection } from "solana-kite";
import {
  getAddQueueAuthorityV0Instruction,
  fetchMaybeTaskQueueAuthorityV0,
  TUKTUK_PROGRAM_ADDRESS,
  TASK_QUEUE_NAME_MAPPING_V0_DISCRIMINATOR,
  getTaskQueueNameMappingV0Decoder,
  getQueueTaskV0InstructionAsync,
} from "./dist/tuktuk-js-client/index.js";
import {
  CRON_PROGRAM_ADDRESS,
  fetchMaybeCronJobNameMappingV0,
} from "./dist/cron-js-client/index.js";
import { taskKey } from "@helium/tuktuk-sdk";

// Previously called initializeTaskQueue - renamed for clarity
export const getTaskQueueAddressFromName = async (
  connection: Connection,
  user: KeyPairSigner,
  taskQueueName: string,
): Promise<Address> => {
  console.log("🔍 Looking for task queue with name:", taskQueueName);

  // Get the TuTuk program's task queue name mapping accounts
  // They look like:
  //
  // {
  //   executable: false,
  //   lamports: 1371120n,
  //   programAddress: 'tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA',
  //   space: 69n,
  //   address: '6kBkBiEhk9hCG1zA13dRYuii8uUViBr4cgXm2Q3MShD4',
  //   data: {
  //     discriminator: [Uint8Array],
  //     taskQueue: 'AB4KBiDsR7xHRNmajerryLdRSVX6AsUFGpeQvEAo7k91',
  //     name: 'crank-tester',
  //     bumpSeed: 255
  //   },
  //   exists: true
  // },
  const getTaskQueueNameMappings = connection.getAccountsFactory(
    TUKTUK_PROGRAM_ADDRESS,
    TASK_QUEUE_NAME_MAPPING_V0_DISCRIMINATOR,
    getTaskQueueNameMappingV0Decoder(),
  );

  // Derive the PDA for the task queue name mapping
  const taskQueueNameMappingPda = await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, [
    "task_queue_name",
    taskQueueName,
  ]);
  console.log("🔍 Task queue name mapping PDA:", taskQueueNameMappingPda.pda);

  // Try to fetch the task queue name mapping to get the actual task queue address
  const nameMappings = await getTaskQueueNameMappings();

  console.log(`we are looking for ${taskQueueName}`);

  // Is there an account with a name that matches the task queue name?
  const queueNameMapping =
    nameMappings.find((nameMapping) => nameMapping.exists && nameMapping.data.name === taskQueueName) || null;

  let taskQueue: Address;
  if (queueNameMapping?.exists) {
    taskQueue = queueNameMapping.data.taskQueue;
    console.log("🔍 Found existing task queue:", taskQueue);
  } else {
    throw new Error(`Task queue with name "${taskQueueName}" not found. You may need to create it first.`);
  }

  // Check if queue authority exists for our wallet
  console.log("🔍 Checking queue authority...");
  const taskQueueAuthority = (
    await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, ["task_queue_authority", taskQueue, user.address])
  ).pda;
  console.log("🔍 Queue authority PDA:", taskQueueAuthority);

  const queueAuthorityAccount = await fetchMaybeTaskQueueAuthorityV0(connection.rpc, taskQueueAuthority);
  console.log("🔍 Queue authority exists:", queueAuthorityAccount.exists);

  if (!queueAuthorityAccount.exists) {
    console.log("Queue authority not found, creating...");
    console.log("🔧 Adding queue authority with accounts:", {
      payer: user.address,
      queueAuthority: user.address,
      taskQueue: taskQueue,
    });

    const addAuthorityInstruction = getAddQueueAuthorityV0Instruction({
      payer: user,
      updateAuthority: user,
      queueAuthority: user.address,
      taskQueueAuthority,
      taskQueue,
    });

    await connection.sendTransactionFromInstructions({
      feePayer: user,
      instructions: [addAuthorityInstruction],
    });
    console.log("✅ Queue authority added");
  }

  console.log("✅ Task queue ready:", taskQueue);
  return taskQueue;
};

// Helper function to find next available task ID from bitmap
const nextAvailableTaskId = (taskBitmap: Uint8Array): number | null => {
  for (let byteIdx = 0; byteIdx < taskBitmap.length; byteIdx++) {
    const byte = taskBitmap[byteIdx];
    if (byte !== 0xff) {
      // If byte is not all 1s
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
  const capacity = new DataView(accountData.buffer, accountData.byteOffset).getUint16(
    TASK_QUEUE_V0_OFFSETS.CAPACITY,
    true,
  );
  const bitmapLen = new DataView(accountData.buffer, accountData.byteOffset).getUint32(
    TASK_QUEUE_V0_OFFSETS.TASK_BITMAP_LEN,
    true,
  );
  const taskBitmap = accountData.slice(
    TASK_QUEUE_V0_OFFSETS.TASK_BITMAP,
    TASK_QUEUE_V0_OFFSETS.TASK_BITMAP + bitmapLen,
  );

  return { capacity, taskBitmap };
};

// Modern queueTask replacement using Solana Kit/Kite/Codama
export const queueTask = async (
  connection: Connection,
  signer: TransactionSigner,
  taskQueue: Address,
  args: {
    trigger: { __kind: "Now" } | { __kind: "Timestamp"; fields: [bigint] };
    transaction: { __kind: "CompiledV0"; fields: [any] };
    crankReward: bigint | null;
    freeTasks: number;
    description: string;
  },
) => {
  // 1. Fetch task queue account to get task bitmap
  const taskQueueAccount = await connection.rpc
    .getAccountInfo(taskQueue, {
      encoding: "base64",
    })
    .send();
  if (!taskQueueAccount.value) {
    throw new Error("Task queue account not found");
  }

  // 2. Parse task bitmap and find available task ID
  let accountData: Uint8Array;
  if (Array.isArray(taskQueueAccount.value.data) && taskQueueAccount.value.data.length === 2) {
    // Account data is [Base64EncodedBytes, "base64"] format
    accountData = new Uint8Array(Buffer.from(taskQueueAccount.value.data[0] as string, "base64"));
  } else if (typeof taskQueueAccount.value.data === "string") {
    // Account data is base64 encoded string
    accountData = new Uint8Array(Buffer.from(taskQueueAccount.value.data, "base64"));
  } else {
    // Already a Uint8Array or other format
    accountData = new Uint8Array(taskQueueAccount.value.data as any);
  }

  const { taskBitmap } = parseTaskQueueV0(accountData);
  const taskId = nextAvailableTaskId(taskBitmap);
  if (taskId === null) {
    throw new Error("No available task slots in queue");
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
export const compileTuktukTransaction = (
  instructions: Array<Instruction>,
  signersSeedsBytes: Array<Array<Buffer>> = [],
) => {
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

  const accounts = accountMetas.map((meta) => meta.address as Address);
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

export const monitorTask = async (connection: Connection, task: Address): Promise<void> => {
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

// Cron SDK functions - simplified implementations
export const getCronJobForName = async (connection: Connection, cronName: string): Promise<Address | null> => {
  const keypair = await connection.loadWalletFromFile("/Users/mike/.config/solana/id.json");
  
  // Use WebCrypto API for SHA256 hash (returns 32 bytes)
  const encoder = new TextEncoder();
  const data = encoder.encode(cronName);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  
  // Use only first 16 bytes of hash to fit within 32-byte seed limit
  const hashBytes = new Uint8Array(hashBuffer).slice(0, 16);
  const hashHex = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  
  // Derive name mapping PDA exactly like the original SDK
  try {
    const nameMapping = await connection.getPDAAndBump(CRON_PROGRAM_ADDRESS, [
      "cron_job_name_mapping",
      keypair.address,
      hashHex,
    ]);
    
    // Fetch the name mapping account
    const cronJobNameMapping = await fetchMaybeCronJobNameMappingV0(connection.rpc, nameMapping.pda);
    
    if (!cronJobNameMapping.exists) {
      return null;
    }
    
    // Return the cronJob address stored in the name mapping
    return cronJobNameMapping.data.cronJob;
  } catch (error) {
    console.error("Error fetching cron job for name:", cronName, error);
    return null;
  }
};

// export async function getCronJobForName(program: Program<Cron>, name: string): Promise<PublicKey | null> {
//     const nameMapping = cronJobNameMappingKey(program.provider.wallet!.publicKey, name)[0];
//     const cronJobNameMapping = await program.account.cronJobNameMappingV0.fetchNullable(nameMapping);
//     if (!cronJobNameMapping) {
//       return null;
//     }
//     return cronJobNameMapping.cronJob;
//   }
