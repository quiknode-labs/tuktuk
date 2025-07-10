// From https://solana.stackexchange.com/questions/16703/can-anchor-client-be-used-with-solana-web3-js-2-0rc
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderJavaScriptVisitor } from "@codama/renderers";
import path from "path";
import { promises as fs } from "fs";

// Instantiate Codama
const anchorIdl = JSON.parse(
  await fs.readFile("../../tuktuk-program/idls/tuktuk.json", "utf-8")
);

const codama = createFromRoot(rootNodeFromAnchor(anchorIdl));

// Render JavaScript.
const generatedPath = path.join("dist", "js-client");
codama.accept(renderJavaScriptVisitor(generatedPath));
