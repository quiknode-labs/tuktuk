// From https://solana.stackexchange.com/questions/16703/can-anchor-client-be-used-with-solana-web3-js-2-0rc
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderJavaScriptVisitor } from "@codama/renderers";
import path from "path";
import { promises as fs } from "fs";

export async function createCodamaClient(idlPath: string, outputPath: string): Promise<void> {
  const anchorIdl = JSON.parse(await fs.readFile(idlPath, "utf-8"));
  const codama = createFromRoot(rootNodeFromAnchor(anchorIdl));
  const generatedPath = path.join("dist", outputPath);
  codama.accept(renderJavaScriptVisitor(generatedPath));
}

// Execute the function with the TukTuk IDL
await createCodamaClient("../../tuktuk-program/idls/tuktuk.json", "tuktuk-js-client");
await createCodamaClient("../../tuktuk-program/idls/cron.json", "cron-js-client");
