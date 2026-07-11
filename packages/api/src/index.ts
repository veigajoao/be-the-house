import { Connection } from "@solana/web3.js";
import { BthClient } from "@bethehouse/sdk";
import { TxLineClient } from "@bethehouse/txline";
import { env, loadIdl, loadKeeper } from "./env.js";
import { Keeper } from "./keeper.js";
import { buildServer } from "./server.js";

const connection = new Connection(env.rpcUrl, "confirmed");
const client = new BthClient(connection, loadIdl(), loadKeeper());
const txline = TxLineClient.fromEnv();

const app = await buildServer(client, txline);
await app.listen({ port: env.port, host: "0.0.0.0" });
console.log(`[api] listening on :${env.port}, rpc ${env.rpcUrl}`);

const keeper = new Keeper(client, txline);
void keeper.run();

process.on("SIGINT", () => {
  keeper.stop();
  void app.close().then(() => process.exit(0));
});
