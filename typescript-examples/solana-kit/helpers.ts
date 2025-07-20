import { KeyPairSigner, type Address } from "@solana/kit";
import { connect, type Connection } from "solana-kite";
import {
  getAddQueueAuthorityV0Instruction,
  fetchMaybeTaskQueueAuthorityV0,
  TUKTUK_PROGRAM_ADDRESS,
  TASK_QUEUE_NAME_MAPPING_V0_DISCRIMINATOR,
  getTaskQueueNameMappingV0Decoder,
} from "./dist/js-client/index.js";

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
