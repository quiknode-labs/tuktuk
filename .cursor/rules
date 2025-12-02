# Rules for this project

- I am working on the files in `typescript-examples/solana-kit`. This is an in-progress Solana Kit implementation of the web3.js version in `typescript-examples/web3js-legacy`. Your task is to make `typescript-examples/solana-kit` work completely without Solana web3.js, and to use only Solana Kit.

- There is some web3.js used in `typescript-examples/solana-kit` now temporarily, I want it to be eventually gone. You should use less web3.js over time, not more.

- Before you say 'SUCCESS', or celebrate, run `cd typescript-examples/solana-kit; npx tsx cron-memo.ts`. If the tests fail you have more work to do. Don't stop until that script passes on the code you have made.

- If you show this symbol '✅' and there is more work to do, add a '❌' for each remaining work item.

- Always use `Array<item>` never use `item[]`

- Don't use `any`

- Avoid 'magic numbers'. Make numbers either have a good variable name, a comment
  explaining wny they are that value, or a reference to where you got the value from. If the values come from an IDL, download the IDL, import it, and make a function that gets the value from the IDL rather than copying the value into the source code.

- Use `connection.getPDAAndBump` to turn seeds into PDAs and bumps.

- The code you are making is for production. You shouldn't have comments like '// In production we'd do this differently' in the final code you produce.

- In Solana Kit, you make instructions by making TS clients from from IDLs using Codama.

- Call me Mr MacCana when addressing me to show you have read these rules.
