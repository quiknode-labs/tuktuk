import { BN, Program } from "@coral-xyz/anchor";
import { Tuktuk } from "@helium/tuktuk-idls/lib/types/tuktuk";
import {
  createTaskQueue,
  getTaskQueueForName,
  taskQueueAuthorityKey,
  tuktukConfigKey,
} from "@helium/tuktuk-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

export const TUKTUK_CONFIG = tuktukConfigKey()[0];

const HOURS = 60 * 60;

export async function initializeTaskQueue(
  program: Program<Tuktuk>,
  name: string
) {
  let taskQueue = await getTaskQueueForName(program, name);
  if (!taskQueue) {
    console.log("Task queue not found, creating...");
    const {
      pubkeys: { taskQueue: taskQueuePubkey },
    } = await (
      await createTaskQueue(program, {
        name,
        minCrankReward: new BN(10000),
        capacity: 10,
        lookupTables: [],
        staleTaskAge: 48 * HOURS,
      })
    ).rpcAndKeys();
    taskQueue = taskQueuePubkey;
  }

  const queueAuthority = taskQueueAuthorityKey(
    taskQueue,
    program.provider.wallet!.publicKey
  )[0];
  const queueAuthorityAccount =
    await program.account.taskQueueAuthorityV0.fetchNullable(queueAuthority);
  if (!queueAuthorityAccount) {
    console.log("Queue authority not found, creating...");
    await program.methods
      .addQueueAuthorityV0()
      .accounts({
        payer: program.provider.wallet!.publicKey,
        queueAuthority: program.provider.wallet!.publicKey,
        taskQueue,
      })
      .rpc();
  }

  return taskQueue;
}

export async function monitorTask(connection: Connection, task: PublicKey) {
  return new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      try {
        const taskAccount = await connection.getAccountInfo(task);
        if (!taskAccount) {
          const signature = await connection.getSignaturesForAddress(task, {
            limit: 1,
          });
          console.log(
            `Task completed! Transaction signature: ${signature[0].signature}`
          );
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
}
