import { ethers } from "ethers";
import { readKuruMainnetAccountOrdersSnapshot } from "../src/kuru-mainnet-readiness";

const account = process.argv[2];
if (!account) {
  throw new Error("Usage: bun run readiness:kuru-mainnet -- <public-wallet-address>");
}

// Fixed public endpoint: this command does not load .env, API keys, or wallet secrets.
const provider = new ethers.providers.JsonRpcProvider("https://rpc.monad.xyz", 143);
const snapshot = await readKuruMainnetAccountOrdersSnapshot(provider, account);
console.log(JSON.stringify({
  status: "READ_ONLY_ACCOUNT_SNAPSHOT",
  chainId: snapshot.chainId,
  market: snapshot.market,
  marketImplementation: snapshot.marketImplementation,
  marginImplementation: snapshot.marginImplementation,
  account: snapshot.account,
  observedBlock: snapshot.observedBlock,
  bookSourceBlock: snapshot.bookSourceBlock,
  marginBaseBalanceRaw: snapshot.marginBaseBalanceRaw,
  marginQuoteBalanceRaw: snapshot.marginQuoteBalanceRaw,
  manualOrderCount: snapshot.manualOrderCount,
  accountOrders: snapshot.accountOrders,
  accountOpenBuyQuoteNotionalRawCeil: snapshot.accountOpenBuyQuoteNotionalRawCeil,
  accountOpenSellBaseTokenRaw: snapshot.accountOpenSellBaseTokenRaw,
  interpretation: "Raw margin balances and current manual-order commitments only; not free collateral or a trading authorization.",
}, null, 2));
