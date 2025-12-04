import {
  KeyPairSigner,
  type Address,
  type Instruction,
  AccountRole,
  type TransactionSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { connect, type Connection } from "solana-kite";
import {
  getAddQueueAuthorityV0Instruction,
  fetchMaybeTaskQueueAuthorityV0,
  TUKTUK_PROGRAM_ADDRESS,
  TASK_QUEUE_NAME_MAPPING_V0_DISCRIMINATOR,
  getTaskQueueNameMappingV0Decoder,
  getQueueTaskV0InstructionAsync,
  getInitializeTaskQueueV0Instruction,
  fetchMaybeTuktukConfigV0,
  fetchTaskQueueV0,
} from "./dist/tuktuk-js-client/index.js";
import {
  CRON_PROGRAM_ADDRESS,
  fetchMaybeCronJobNameMappingV0,
  getInitializeCronJobV0InstructionAsync,
  fetchMaybeUserCronJobsV0,
  getAddCronTransactionV0Instruction,
} from "./dist/cron-js-client/index.js";
import { getTransferSolInstruction } from "@solana-program/system";

const addressEncoder = getAddressEncoder();

// Convert a BigInt to a little-endian byte array of specified length
// Used for encoding numeric seeds for PDA derivation
const bigIntToSeed = (bigInt: bigint, byteLength: number): Uint8Array => {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength && bigInt > 0n; i++) {
    bytes[i] = Number(bigInt & 0xffn); // Get least significant byte
    bigInt >>= 8n; // Shift right by 8 bits
  }
  return bytes;
};

export const getOrCreateTaskQueue = async (
  connection: Connection,
  user: KeyPairSigner,
  taskQueueName: string,
): Promise<Address> => {
  // Get the tuktuk config PDA (seeds: ["tuktuk_config"])
  const tuktukConfigPda = await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, ["tuktuk_config"]);
  const tuktukConfig = tuktukConfigPda.pda;

  // Derive the PDA for the task queue name mapping
  // Seeds: ["task_queue_name_mapping", tuktukConfig, sha256(name)]
  const taskQueueNameHash = await hashTaskQueueName(taskQueueName);
  const taskQueueNameMappingPda = await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, [
    "task_queue_name_mapping",
    tuktukConfig,
    taskQueueNameHash,
  ]);

  // Get the TuTuk program's task queue name mapping accounts
  const getTaskQueueNameMappings = connection.getAccountsFactory(
    TUKTUK_PROGRAM_ADDRESS,
    TASK_QUEUE_NAME_MAPPING_V0_DISCRIMINATOR,
    getTaskQueueNameMappingV0Decoder(),
  );

  // Try to fetch the task queue name mapping to get the actual task queue address
  const nameMappings = await getTaskQueueNameMappings();

  // Search for an existing task queue with this name
  const queueNameMapping =
    nameMappings.find((nameMapping) => nameMapping.exists && nameMapping.data.name === taskQueueName) || null;

  let taskQueue: Address;
  if (queueNameMapping?.exists) {
    taskQueue = queueNameMapping.data.taskQueue;
  } else {
    console.log("Task queue not found, creating...");

    // Fetch the tuktuk config to get the next task queue ID
    const tuktukConfigAccount = await fetchMaybeTuktukConfigV0(connection.rpc, tuktukConfig);
    if (!tuktukConfigAccount.exists) {
      throw new Error("TukTuk config not found. The program may not be initialized.");
    }
    const nextTaskQueueId = tuktukConfigAccount.data.nextTaskQueueId;

    // Derive the task queue PDA
    // Seeds: ["task_queue", tuktukConfig, nextTaskQueueId (as u32 LE)]
    const taskQueueIdBuffer = bigIntToSeed(BigInt(nextTaskQueueId), 4);
    const taskQueuePda = await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, [
      "task_queue",
      tuktukConfig,
      taskQueueIdBuffer,
    ]);
    taskQueue = taskQueuePda.pda;

    // Create the task queue
    const HOURS_IN_SECONDS = 60 * 60;
    const MIN_CRANK_REWARD = 10000n;
    const CAPACITY = 10;
    const STALE_TASK_AGE_SECONDS = 48 * HOURS_IN_SECONDS;

    const createTaskQueueInstruction = getInitializeTaskQueueV0Instruction({
      payer: user,
      tuktukConfig,
      updateAuthority: user.address,
      taskQueue,
      taskQueueNameMapping: taskQueueNameMappingPda.pda,
      minCrankReward: MIN_CRANK_REWARD,
      name: taskQueueName,
      capacity: CAPACITY,
      lookupTables: [],
      staleTaskAge: STALE_TASK_AGE_SECONDS,
    });

    await connection.sendTransactionFromInstructions({
      feePayer: user,
      instructions: [createTaskQueueInstruction],
    });

    console.log("✅ Task queue created:", taskQueue);
  }

  // Check if queue authority exists for our wallet
  const taskQueueAuthority = (
    await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, ["task_queue_authority", taskQueue, user.address])
  ).pda;

  const queueAuthorityAccount = await fetchMaybeTaskQueueAuthorityV0(connection.rpc, taskQueueAuthority);

  if (!queueAuthorityAccount.exists) {
    console.log("Adding queue authority...");

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

// Queue a task to be executed on a task queue
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

  // 3. Derive task PDA (seeds: ["task", taskQueue, taskId (u16 LE)])
  const taskIdBuffer = bigIntToSeed(BigInt(taskId), 2);
  const taskPda = await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, ["task", taskQueue, taskIdBuffer]);
  const taskAddress = taskPda.pda;

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
  const TASK_POLL_INTERVAL_MS = 2000; // Poll every 2 seconds
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
    }, TASK_POLL_INTERVAL_MS);
  });
};

const hashCronName = async (cronName: string): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(cronName);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // Return the hash bytes directly - no need for hex conversion roundtrip
  return new Uint8Array(hashBuffer);
};

// Hash a task queue name using SHA-256
const hashTaskQueueName = async (name: string): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(name);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
};

export const getCronJobForName = async (
  connection: Connection,
  authority: KeyPairSigner,
  cronName: string,
): Promise<Address | null> => {
  try {
    // Derive cron job name mapping PDA (seeds: ["cron_job_name_mapping", authority, sha256(name)])
    const { pda: nameMappingAddress } = await connection.getPDAAndBump(CRON_PROGRAM_ADDRESS, [
      "cron_job_name_mapping",
      authority.address,
      await hashCronName(cronName),
    ]);

    // Fetch the name mapping account
    const cronJobNameMapping = await fetchMaybeCronJobNameMappingV0(connection.rpc, nameMappingAddress);

    if (!cronJobNameMapping.exists) {
      return null;
    }

    // Return the cronJob address stored in the name mapping
    return cronJobNameMapping.data.cronJob;
  } catch (error) {
    throw new Error(`Error fetching cron job for name: ${cronName}`, { cause: error });
  }
};

// Create a new cron job
export const createCronJob = async (
  connection: Connection,
  authority: KeyPairSigner,
  taskQueue: Address,
  args: {
    name: string;
    schedule: string;
    freeTasksPerTransaction: number;
    numTasksPerQueueCall: number;
  },
): Promise<Address> => {
  console.log("Creating cron job:", args.name);

  // Get user_cron_jobs PDA (seeds: ["user_cron_jobs", authority])
  const userCronJobsPda = await connection.getPDAAndBump(CRON_PROGRAM_ADDRESS, ["user_cron_jobs", authority.address]);

  // Fetch userCronJobs to get the next cron job ID
  const userCronJobs = await fetchMaybeUserCronJobsV0(connection.rpc, userCronJobsPda.pda);
  const nextCronJobId = userCronJobs.exists ? userCronJobs.data.nextCronJobId : 0;

  // Derive cron job PDA (seeds: ["cron_job", authority, nextCronJobId (u32 LE)])
  const cronJobIdBuffer = bigIntToSeed(BigInt(nextCronJobId), 4);
  const cronJobPda = await connection.getPDAAndBump(CRON_PROGRAM_ADDRESS, [
    "cron_job",
    authority.address,
    cronJobIdBuffer,
  ]);
  const cronJob = cronJobPda.pda;

  // Derive cron job name mapping PDA (seeds: ["cron_job_name_mapping", authority, sha256(name)])
  const cronJobNameHash = await hashCronName(args.name);
  const cronJobNameMappingPda = await connection.getPDAAndBump(CRON_PROGRAM_ADDRESS, [
    "cron_job_name_mapping",
    authority.address,
    cronJobNameHash,
  ]);

  // Fetch task queue to find next available task ID
  const taskQueueAccount = await fetchTaskQueueV0(connection.rpc, taskQueue);
  const taskBitmap = taskQueueAccount.data.taskBitmap;
  const nextTaskId = nextAvailableTaskId(taskBitmap);
  if (nextTaskId === null) {
    throw new Error("No available task slots in queue");
  }

  // Derive task PDA (seeds: ["task", taskQueue, nextTaskId (u16 LE)])
  const taskIdBuffer = bigIntToSeed(BigInt(nextTaskId), 2);
  const taskPda = await connection.getPDAAndBump(TUKTUK_PROGRAM_ADDRESS, ["task", taskQueue, taskIdBuffer]);
  const task = taskPda.pda;

  // Create the initialize cron job instruction
  const initInstruction = await getInitializeCronJobV0InstructionAsync({
    payer: authority,
    queueAuthority: authority,
    authority,
    cronJob,
    cronJobNameMapping: cronJobNameMappingPda.pda,
    taskQueue,
    task,
    schedule: args.schedule,
    name: args.name,
    freeTasksPerTransaction: args.freeTasksPerTransaction,
    numTasksPerQueueCall: args.numTasksPerQueueCall,
  });

  await connection.sendTransactionFromInstructions({
    feePayer: authority,
    instructions: [initInstruction],
  });

  console.log("✅ Cron job created:", cronJob);
  return cronJob;
};

// Add a transaction to a cron job
export const addCronTransaction = async (
  connection: Connection,
  authority: KeyPairSigner,
  cronJob: Address,
  transactionIndex: number,
  transaction: ReturnType<typeof compileTuktukTransaction>,
): Promise<void> => {
  console.log(`Adding transaction ${transactionIndex} to cron job...`);

  // Derive cron job transaction PDA (seeds: ["cron_job_transaction", cronJob, transactionIndex (u32 LE)])
  const cronJobTransactionIdBuffer = bigIntToSeed(BigInt(transactionIndex), 4);
  const cronJobTransactionPda = await connection.getPDAAndBump(CRON_PROGRAM_ADDRESS, [
    "cron_job_transaction",
    cronJob,
    cronJobTransactionIdBuffer,
  ]);

  const addTransactionInstruction = getAddCronTransactionV0Instruction({
    payer: authority,
    authority,
    cronJob,
    cronJobTransaction: cronJobTransactionPda.pda,
    index: transactionIndex,
    transactionSource: {
      __kind: "CompiledV0" as const,
      fields: [transaction],
    },
  });

  await connection.sendTransactionFromInstructions({
    feePayer: authority,
    instructions: [addTransactionInstruction],
  });

  console.log("✅ Transaction added to cron job");
};
