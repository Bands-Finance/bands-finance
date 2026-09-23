/**
 * Hot-watch tests: metric math, heat ordering and every flag, the surge rules on a synthetic tape,
 * hotPicks filtering, both API shapes, dex id mapping, a whole tick on a fake fetch with no network,
 * the file round-trip, GET /api/hot and the watch scheduler. Fixtures are real API rows (2026-09-13).
 *   npm run test:hot
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  boardFee,
  boardTop,
  DEXSCREENER_URL,
  detectSurges,
  fetchTrending,
  flipPct,
  heatOf,
  heldPools,
  hotEnv,
  hotMetrics,
  hotPicks,
  hotRoutes,
  identityOf,
  originOf,
  inputsOf,
  loadHot,
  orient,
  parseDexScreener,
  parseHistory,
  parsePumpSwapPools,
  parseTrending,
  PUMPSWAP_URL,
  quoteSymbolOf,
  readHistoryTail,
  rolledTape,
  runHotTick,
  solPriceFromSamples,
  splitName,
  startHotWatch,
  topTenSeen,
  TRENDING_URL,
  venueOfDex,
} from "../hot";
import type { FeeCacheEntry, HotFile, HotHistoryRow, HotMetrics, HotRow, PoolSample } from "../hot";
import type { ScreenedPool, ScreenResult } from "../screener/types";
import { meteoraBoardFees } from "../screener/scan";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL  ${name}`);
      console.error(err);
      process.exit(1);
    });
}
const near = (a: number | null, b: number, tol = 1e-3) => {
  assert.ok(a !== null, `expected ${b}, got null`);
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `expected ${b}, got ${a}`);
};

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = Date.parse("2026-09-13T11:00:00Z");
const H = 3600e3;

/* ---------- fixtures: GeckoTerminal trending rows (2026-09-13, prices shortened) ---------- */
const EMBER_SOL = "D3P1NfTww6ib5bW885XypnHTho1BmtyAq9saFgfzjbyw";
const DKNG_USDC = "BzqqgCeFMxJ45rYhneXnVGwkZw5SHdPcSEc4qyY6ygFg";
const ANSEM_SOL = "6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN";
const STONK_SOL = "zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX";
const EMBER_USDC = "6e4ewHhGZrBMiSkKat7QCx28dytJdnYrobNXWrPL5WFN";
const JUBJUB_ZEC = "8myc52qh4zCDWXBnW9UxbJMs1cu6aNMcsa4VCK5Hw9R3";
const MIZO_SOL = "G2pNaeFEUaq8ArWbCYe1wv8vRfd2ZL8LjPN8mcJqGeop";
const ZEC_ZCAT = "BTccxxTFi7a9xJTE1exKn38Jgie35s6gNeRxd8DM61Rc";
const SOL_USDC = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

const TRENDING_5M = {"data":[{"id":"solana_8myc52qh4zCDWXBnW9UxbJMs1cu6aNMcsa4VCK5Hw9R3","type":"pool","attributes":{"base_token_price_usd":"0.001949414","base_token_price_native_currency":"1.95378e-05","quote_token_price_usd":"1100.6517594239","quote_token_price_native_currency":"11.0090670855","base_token_price_quote_token":"1.7747e-06","quote_token_price_base_token":"563474.983287909","address":"8myc52qh4zCDWXBnW9UxbJMs1cu6aNMcsa4VCK5Hw9R3","name":"JubJub / ZEC","pool_created_at":"2026-09-13T00:51:59Z","fdv_usd":"1949406.558","market_cap_usd":null,"price_change_percentage":{"m5":"6.989","m15":"9.789","m30":"12.198","h1":"-20.075","h6":"75.721","h24":"4344.788"},"transactions":{"m5":{"buys":37,"sells":17,"buyers":30,"sellers":14},"m15":{"buys":117,"sells":102,"buyers":69,"sellers":79},"m30":{"buys":335,"sells":297,"buyers":163,"sellers":176},"h1":{"buys":633,"sells":565,"buyers":283,"sellers":318},"h6":{"buys":4154,"sells":3535,"buyers":1430,"sellers":1387},"h24":{"buys":15906,"sells":12356,"buyers":4472,"sellers":3583}},"volume_usd":{"m5":"6986.0499791446","m15":"30397.9164778589","m30":"95241.560595001","h1":"218692.710494242","h6":"1367239.16189016","h24":"4682215.73334546"},"reserve_in_usd":"128242.2069"},"relationships":{"base_token":{"data":{"id":"solana_7tFbGa9wt4Q4yxNAdaDcTKahv4WPrJtXh6ty7gjWyKx3","type":"token"}},"quote_token":{"data":{"id":"solana_A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS","type":"token"}},"dex":{"data":{"id":"raydium","type":"dex"}}}},{"id":"solana_zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX","type":"pool","attributes":{"base_token_price_usd":"0.2673600539","base_token_price_native_currency":"0.0026903635","quote_token_price_usd":"99.7757213356","quote_token_price_native_currency":"1.0","base_token_price_quote_token":"0.0026903635","quote_token_price_base_token":"371.696984389","address":"zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX","name":"STONK / SOL","pool_created_at":"2026-08-12T10:51:40Z","fdv_usd":"228044657.419344","market_cap_usd":"228068021.886748","price_change_percentage":{"m5":"0.203","m15":"0.045","m30":"-0.89","h1":"-2.495","h6":"-12.675","h24":"-2.431"},"transactions":{"m5":{"buys":85,"sells":28,"buyers":45,"sellers":26},"m15":{"buys":229,"sells":79,"buyers":133,"sellers":68},"m30":{"buys":426,"sells":166,"buyers":217,"sellers":128},"h1":{"buys":705,"sells":245,"buyers":315,"sellers":187},"h6":{"buys":4037,"sells":2533,"buyers":1473,"sellers":1240},"h24":{"buys":23822,"sells":20786,"buyers":7257,"sellers":6676}},"volume_usd":{"m5":"37110.6689539281","m15":"245075.819658367","m30":"462450.596541977","h1":"721653.293601921","h6":"3388454.84578009","h24":"26867197.6298484"},"reserve_in_usd":"2825964.6374"},"relationships":{"base_token":{"data":{"id":"solana_6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"meteora","type":"dex"}}}},{"id":"solana_G2pNaeFEUaq8ArWbCYe1wv8vRfd2ZL8LjPN8mcJqGeop","type":"pool","attributes":{"base_token_price_usd":"0.000286061","base_token_price_native_currency":"2.8991e-06","quote_token_price_usd":"99.7764834138","quote_token_price_native_currency":"1.0","base_token_price_quote_token":"2.8991e-06","quote_token_price_base_token":"344937.942953021","address":"G2pNaeFEUaq8ArWbCYe1wv8vRfd2ZL8LjPN8mcJqGeop","name":"MIZO / SOL","pool_created_at":"2026-09-13T08:53:28Z","fdv_usd":"308669.5927","market_cap_usd":null,"price_change_percentage":{"m5":"10.628","m15":"-3.632","m30":"-41.935","h1":"-21.988","h6":"639.654","h24":"639.654"},"transactions":{"m5":{"buys":272,"sells":216,"buyers":200,"sellers":147},"m15":{"buys":948,"sells":705,"buyers":550,"sellers":468},"m30":{"buys":1822,"sells":1221,"buyers":918,"sellers":791},"h1":{"buys":3062,"sells":2337,"buyers":1438,"sellers":1294},"h6":{"buys":16768,"sells":13224,"buyers":5612,"sellers":4456},"h24":{"buys":16768,"sells":13224,"buyers":5612,"sellers":4456}},"volume_usd":{"m5":"39386.7934316454","m15":"124952.864512644","m30":"213187.533460992","h1":"354580.661998471","h6":"1922829.00327039","h24":"1922829.00327039"},"reserve_in_usd":"48958.9209"},"relationships":{"base_token":{"data":{"id":"solana_5Zspimi8VD6LctJLtaSjLqaSUvmh3Rs849iPtGocpump","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"pumpswap","type":"dex"}}}}]};
const TRENDING_1H = {"data":[{"id":"solana_6e4ewHhGZrBMiSkKat7QCx28dytJdnYrobNXWrPL5WFN","type":"pool","attributes":{"base_token_price_usd":"0.0362818436","base_token_price_native_currency":"0.0003667223","quote_token_price_usd":"0.9997574114","quote_token_price_native_currency":"0.0100260982","base_token_price_quote_token":"0.036576769","quote_token_price_base_token":"27.3397576271","address":"6e4ewHhGZrBMiSkKat7QCx28dytJdnYrobNXWrPL5WFN","name":"EMBER / USDC","pool_created_at":"2026-09-10T05:53:50Z","fdv_usd":"36278935.0507101","market_cap_usd":"36282444.6716125","price_change_percentage":{"m5":"-2.945","m15":"-2.012","m30":"1.069","h1":"4.62","h6":"3.841","h24":"66.151"},"transactions":{"m5":{"buys":218,"sells":52,"buyers":141,"sellers":41},"m15":{"buys":371,"sells":155,"buyers":234,"sellers":123},"m30":{"buys":692,"sells":503,"buyers":385,"sellers":334},"h1":{"buys":935,"sells":775,"buyers":526,"sellers":491},"h6":{"buys":5187,"sells":3816,"buyers":2506,"sellers":1988},"h24":{"buys":20977,"sells":17185,"buyers":8740,"sellers":7864}},"volume_usd":{"m5":"67725.6713662553","m15":"183067.336686509","m30":"534721.682163583","h1":"793996.91072468","h6":"3409869.67946854","h24":"14085600.3429266"},"reserve_in_usd":"1072260.5508"},"relationships":{"base_token":{"data":{"id":"solana_5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6","type":"token"}},"quote_token":{"data":{"id":"solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","type":"token"}},"dex":{"data":{"id":"meteora","type":"dex"}}}},{"id":"solana_BTccxxTFi7a9xJTE1exKn38Jgie35s6gNeRxd8DM61Rc","type":"pool","attributes":{"base_token_price_usd":"1097.9754036536","base_token_price_native_currency":"11.0090670676","quote_token_price_usd":"0.0942681156","quote_token_price_native_currency":"0.0009451979","base_token_price_quote_token":"11647.367682632","quote_token_price_base_token":"8.58563e-05","address":"BTccxxTFi7a9xJTE1exKn38Jgie35s6gNeRxd8DM61Rc","name":"ZEC / ZCAT","pool_created_at":"2026-08-30T23:29:55Z","fdv_usd":"106556863.22979","market_cap_usd":"106213877.588181","price_change_percentage":{"m5":"-0.279","m15":"0.291","m30":"0.515","h1":"-0.086","h6":"-4.415","h24":"-4.766"},"transactions":{"m5":{"buys":4,"sells":11,"buyers":4,"sellers":9},"m15":{"buys":19,"sells":16,"buyers":17,"sellers":11},"m30":{"buys":27,"sells":26,"buyers":22,"sellers":18},"h1":{"buys":39,"sells":42,"buyers":32,"sellers":26},"h6":{"buys":217,"sells":179,"buyers":154,"sellers":110},"h24":{"buys":3453,"sells":3650,"buyers":1523,"sellers":1754}},"volume_usd":{"m5":"1109.9433817948","m15":"19906.7950218769","m30":"22447.8538722611","h1":"54259.8121367021","h6":"187971.228105984","h24":"4061000.79528906"},"reserve_in_usd":"1449156.0667"},"relationships":{"base_token":{"data":{"id":"solana_A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS","type":"token"}},"quote_token":{"data":{"id":"solana_HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR","type":"token"}},"dex":{"data":{"id":"raydium-clmm","type":"dex"}}}},{"id":"solana_58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2","type":"pool","attributes":{"base_token_price_usd":"99.7431304767","base_token_price_native_currency":"1.0","quote_token_price_usd":"1.0000041521","quote_token_price_native_currency":"0.0100261071","base_token_price_quote_token":"99.739608683","quote_token_price_base_token":"0.0100261071","address":"58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2","name":"SOL / USDC","pool_created_at":"2022-04-28T09:46:08Z","fdv_usd":"1260170497.56257","market_cap_usd":"1261497962.50081","price_change_percentage":{"m5":"-0.268","m15":"-0.1","m30":"-0.116","h1":"-0.231","h6":"-2.319","h24":"-2.255"},"transactions":{"m5":{"buys":334,"sells":477,"buyers":130,"sellers":182},"m15":{"buys":1318,"sells":1418,"buyers":553,"sellers":553},"m30":{"buys":2917,"sells":3244,"buyers":1149,"sellers":1153},"h1":{"buys":7412,"sells":8352,"buyers":2325,"sellers":2426},"h6":{"buys":38023,"sells":38653,"buyers":7539,"sellers":7672},"h24":{"buys":566546,"sells":588975,"buyers":37488,"sellers":49510}},"volume_usd":{"m5":"30902.8879795444","m15":"149567.860082818","m30":"392930.081528201","h1":"1042451.67184295","h6":"4743370.84710272","h24":"81777827.2609474"},"reserve_in_usd":"30781349.7989"},"relationships":{"base_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"quote_token":{"data":{"id":"solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","type":"token"}},"dex":{"data":{"id":"raydium","type":"dex"}}}}]};

/* ---------- fixture: GeckoTerminal GET /networks/solana/dexes/pumpswap/pools?page=1&sort=h24_volume_usd_desc (2026-09-14, three of twenty rows) ---------- */
const NIKE_PUMP = "DEjtpp7WwmPV3pUYtcRbkdSgtdc1o9XdzURFKhQJHCKW";
const CLAUDE_PUMP = "E59Az3Dg62mxTK1RitxqLsWoSYY8HjmzKJgFQMyNrJZt";
const NVIDA_PUMP = "4ynjBnDoFaFqG18rzHAb4qUWHvLDYRcQu2Vcw4f4kJov";
const PUMPSWAP_P1 = {"data":[{"id":"solana_4ynjBnDoFaFqG18rzHAb4qUWHvLDYRcQu2Vcw4f4kJov","type":"pool","attributes":{"base_token_price_usd":"0.00332180857656177758726853214664855149082568612934751115469452462","base_token_price_native_currency":"0.000000794100493902803","quote_token_price_usd":"102.786869790566661724357325006868517330927878358","base_token_price_quote_token":"0.0000007941004939","address":"4ynjBnDoFaFqG18rzHAb4qUWHvLDYRcQu2Vcw4f4kJov","name":"NVIDA / SOL","pool_created_at":"2026-09-14T01:48:12Z","price_change_percentage":{"m5":"0","h1":"0","h24":"49208.989"},"transactions":{"m5":{"buys":0,"sells":0,"buyers":0,"sellers":0},"h1":{"buys":0,"sells":1,"buyers":0,"sellers":1}},"volume_usd":{"m5":"0.0","h1":"0.0005179430369","h24":"153213664.826206"},"reserve_in_usd":"0.0005194151104"},"relationships":{"base_token":{"data":{"id":"solana_4K6DVWbekNpa9DL4pwwguLPrYpoq7DuTyzC5Y42yrhFc","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"pumpswap","type":"dex"}}}},{"id":"solana_E59Az3Dg62mxTK1RitxqLsWoSYY8HjmzKJgFQMyNrJZt","type":"pool","attributes":{"base_token_price_usd":"0.0000562818192667101029620173993567489123250083042780882759143088352","base_token_price_native_currency":"0.000000547514903244825","quote_token_price_usd":"102.795045273029428904061259366770158778061127648","base_token_price_quote_token":"0.0000005475149032","address":"E59Az3Dg62mxTK1RitxqLsWoSYY8HjmzKJgFQMyNrJZt","name":"Claude / SOL","pool_created_at":"2026-09-14T19:10:21Z","price_change_percentage":{"m5":"0","h1":"6.097","h24":"728.106"},"transactions":{"m5":{"buys":0,"sells":0,"buyers":0,"sellers":0},"h1":{"buys":4467,"sells":3197,"buyers":1289,"sellers":19}},"volume_usd":{"m5":"0.0","h1":"6436833.1549629","h24":"71088783.0427548"},"reserve_in_usd":"0.000000775549427174192"},"relationships":{"base_token":{"data":{"id":"solana_DJaLFMuqBa4JupES5KzRV5YHLRPMTQM2spm1jurt6Fa9","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"pumpswap","type":"dex"}}}},{"id":"solana_DEjtpp7WwmPV3pUYtcRbkdSgtdc1o9XdzURFKhQJHCKW","type":"pool","attributes":{"base_token_price_usd":"0.0000300682119094559366707264239441141554599365040231325574430639619","base_token_price_native_currency":"0.000000291245474866189","quote_token_price_usd":"102.723849419367223889107022861340069400336547591","base_token_price_quote_token":"0.0000002912454749","address":"DEjtpp7WwmPV3pUYtcRbkdSgtdc1o9XdzURFKhQJHCKW","name":"NIKE / SOL","pool_created_at":"2026-09-14T19:48:27Z","price_change_percentage":{"m5":"0.515","h1":"6.998","h24":"225.558"},"transactions":{"m5":{"buys":114,"sells":114,"buyers":20,"sellers":20},"h1":{"buys":6365,"sells":6333,"buyers":22,"sellers":21}},"volume_usd":{"m5":"223412.523150477","h1":"12394850.3308151","h24":"48129456.0489997"},"reserve_in_usd":"343798.9297"},"relationships":{"base_token":{"data":{"id":"solana_FHDQkQtKVhjRMMTDDNfSyQq5tg5ADbQ1zmEv1k88V9pd","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"pumpswap","type":"dex"}}}}]};

/* ---------- fixture: DexScreener GET /latest/dex/pairs/solana/<addrs> (2026-09-13, `info` and `url` dropped) ---------- */
type DexPair = { pairAddress: string; volume: Record<string, number>; [k: string]: unknown };
const DEX: { schemaVersion: string; pairs: DexPair[] } = {"schemaVersion":"1.0.0","pairs":[{"chainId":"solana","dexId":"orca","pairAddress":"D3P1NfTww6ib5bW885XypnHTho1BmtyAq9saFgfzjbyw","labels":["wp"],"baseToken":{"address":"5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6","name":"embercurve","symbol":"EMBER"},"quoteToken":{"address":"So11111111111111111111111111111111111111112","name":"Wrapped SOL","symbol":"SOL"},"priceNative":"0.0003605","priceUsd":"0.03596","txns":{"m5":{"buys":0,"sells":13},"h1":{"buys":105,"sells":30},"h6":{"buys":539,"sells":295},"h24":{"buys":3287,"sells":2363}},"volume":{"h24":3671325.07,"h6":400531.37,"h1":87330.71,"m5":12273.7},"priceChange":{"m5":-2.46,"h1":1.74,"h6":2.13,"h24":62.2},"liquidity":{"usd":426872.27,"base":5462307,"quote":2309.5789},"fdv":35968075,"marketCap":35968075,"pairCreatedAt":1788996264000},{"chainId":"solana","dexId":"raydium","pairAddress":"BzqqgCeFMxJ45rYhneXnVGwkZw5SHdPcSEc4qyY6ygFg","labels":["CLMM"],"baseToken":{"address":"DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow","name":"DraftKings - Backpack Securities","symbol":"DKNG"},"quoteToken":{"address":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","name":"USD Coin","symbol":"USDC"},"priceNative":"23.8823","priceUsd":"23.88","txns":{"m5":{"buys":0,"sells":0},"h1":{"buys":0,"sells":9},"h6":{"buys":6,"sells":64},"h24":{"buys":1354,"sells":1344}},"volume":{"h24":407530.99,"h6":1072.33,"h1":130.22,"m5":0},"priceChange":{"h1":-0.1,"h6":-0.46,"h24":-0.97},"liquidity":{"usd":2315.23,"base":73.08838,"quote":569.7196},"pairCreatedAt":1789159663000},{"chainId":"solana","dexId":"meteora","pairAddress":"6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN","labels":["DLMM"],"baseToken":{"address":"9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump","name":"The Black Bull","symbol":"ANSEM"},"quoteToken":{"address":"So11111111111111111111111111111111111111112","name":"Wrapped SOL","symbol":"SOL"},"priceNative":"0.001570","priceUsd":"0.1567","txns":{"m5":{"buys":3,"sells":6},"h1":{"buys":95,"sells":47},"h6":{"buys":938,"sells":693},"h24":{"buys":11283,"sells":8810}},"volume":{"h24":4025807.71,"h6":371583.39,"h1":33949.51,"m5":653.24},"priceChange":{"m5":-0.03,"h1":-0.84,"h6":-3.83,"h24":3.96},"liquidity":{"usd":1413896.92,"base":5453269,"quote":5607.1343},"fdv":156700307,"marketCap":156700307,"pairCreatedAt":1782628736000},{"chainId":"solana","dexId":"meteora","pairAddress":"zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX","labels":["DLMM"],"baseToken":{"address":"6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx","name":"STONK","symbol":"STONK"},"quoteToken":{"address":"So11111111111111111111111111111111111111112","name":"Wrapped SOL","symbol":"SOL"},"priceNative":"0.002711","priceUsd":"0.2704","txns":{"m5":{"buys":87,"sells":57},"h1":{"buys":725,"sells":288},"h6":{"buys":4032,"sells":2546},"h24":{"buys":23857,"sells":20833}},"volume":{"h24":26876791.39,"h6":3388780.51,"h1":753610.54,"m5":48624.1},"priceChange":{"m5":0.76,"h1":-1.49,"h6":-11.77,"h24":-1.27},"liquidity":{"usd":2841734.9,"base":4067952,"quote":17462},"fdv":270457059,"marketCap":237118849,"pairCreatedAt":1786531900000},{"chainId":"solana","dexId":"meteora","pairAddress":"6e4ewHhGZrBMiSkKat7QCx28dytJdnYrobNXWrPL5WFN","labels":["DLMM"],"baseToken":{"address":"5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6","name":"embercurve","symbol":"EMBER"},"quoteToken":{"address":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","name":"USD Coin","symbol":"USDC"},"priceNative":"0.03607","priceUsd":"0.03607","txns":{"m5":{"buys":91,"sells":67},"h1":{"buys":970,"sells":803},"h6":{"buys":5274,"sells":3906},"h24":{"buys":21300,"sells":17617}},"volume":{"h24":14097354.03,"h6":3413128.05,"h1":795383.42,"m5":42580.61},"priceChange":{"m5":-1.06,"h1":6.74,"h6":3.27,"h24":62.51},"liquidity":{"usd":1066950.47,"base":10325294,"quote":694416},"fdv":36079711,"marketCap":35923137,"pairCreatedAt":1789019630000},{"chainId":"solana","dexId":"raydium","pairAddress":"8myc52qh4zCDWXBnW9UxbJMs1cu6aNMcsa4VCK5Hw9R3","labels":["CPMM"],"baseToken":{"address":"7tFbGa9wt4Q4yxNAdaDcTKahv4WPrJtXh6ty7gjWyKx3","name":"Zcash Official Mascot","symbol":"JubJub"},"quoteToken":{"address":"A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS","name":"Zcash","symbol":"ZEC"},"priceNative":"0.000001719","priceUsd":"0.001888","txns":{"m5":{"buys":35,"sells":20},"h1":{"buys":623,"sells":565},"h6":{"buys":4056,"sells":3501},"h24":{"buys":15892,"sells":12418}},"volume":{"h24":4696972.71,"h6":1368191.17,"h1":221686.37,"m5":10088.85},"priceChange":{"m5":-1.12,"h1":-23.07,"h6":103,"h24":4726},"liquidity":{"usd":125803.76,"base":33308462,"quote":57.2735},"fdv":1888465,"marketCap":1888465,"pairCreatedAt":1789260719000}]};

/* ---------- fixture: a small board (data/screen.json rows, trimmed to the fields the watch reads) ---------- */
function boardRow(o: Partial<ScreenedPool> & Pick<ScreenedPool, "address" | "name" | "venue" | "rank" | "baseFeePct" | "dynamicFeePct">): ScreenedPool {
  return {
    baseMint: "", quoteMint: SOL, quoteSymbol: "SOL", baseDecimals: 6, quoteDecimals: 9, stepBps: 100, binStep: 100, activeBinId: 0, price: 0, reserveBase: 0, reserveQuote: 0, tvlQuote: 0, quoteShare: 0.5,
    lastTradeAt: null, volatilityAccumulator: 0, maxVolatilityAccumulator: 0, protocolFeeBase: "0", protocolFeeQuote: "0", protocolSharePct: 0, baseSymbol: o.name.split(" / ")[0], tvlUsd: null, volume24hUsd: null, fees24hUsd: null,
    priceChange24hPct: null, ageHours: null, stock: null, feesSource: null, feesWindowHours: null, feeToTvl24hPct: null, turnover24h: null, binRangePct: null, txns24h: null, mcapUsd: null, fdvUsd: null, priceUsd: null, score: 50, flags: [],
    ...o,
  };
}
const SCREEN: ScreenResult = {
  generatedAt: new Date(NOW - 10 * 60e3).toISOString(),
  scanMs: 1,
  scannedPools: 2,
  livePools: 2,
  rankedPools: 2,
  solPriceUsd: 99.81,
  pools: [
    boardRow({ address: EMBER_SOL, name: "EMBER / SOL", venue: "orca-whirlpool", rank: 1, baseFeePct: 2, dynamicFeePct: 2.0103, baseMint: "5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6", tvlUsd: 418168, ageHours: 83.3 }),
    boardRow({ address: DKNG_USDC, name: "DKNG / USDC", venue: "raydium-clmm", rank: 2, baseFeePct: 0.15, dynamicFeePct: 0.15, baseMint: "DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow", quoteMint: USDC, quoteSymbol: "USDC", stock: { ticker: "DKNG", issuer: "backpack" } }),
  ],
  venues: [],
  stocks: 1,
};

/* ---------- a fake fetch: serves the fixtures by URL, refuses anything else, never touches the network ---------- */
function fakeFetch(o: { calls?: string[]; h1Override?: Record<string, number>; failTrending?: boolean; firstTrending429?: boolean; failPumpswap?: boolean } = {}): typeof fetch {
  let trendingCalls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    o.calls?.push(url);
    const u = new URL(url);
    if (u.host === "api.geckoterminal.com" && u.pathname.endsWith("/trending_pools")) {
      trendingCalls++;
      if (o.failTrending) throw new Error("ECONNRESET");
      if (o.firstTrending429 && trendingCalls === 1) return json({ errors: [{ status: "429" }] }, 429);
      const d = u.searchParams.get("duration");
      return json(d === "5m" ? TRENDING_5M : d === "1h" ? TRENDING_1H : { data: [] });
    }
    if (u.host === "api.geckoterminal.com" && u.pathname.endsWith("/dexes/pumpswap/pools")) {
      if (o.failPumpswap) return json({ errors: [{ status: "500" }] }, 500);
      return json(u.searchParams.get("page") === "1" ? PUMPSWAP_P1 : { data: [] });
    }
    if (u.host === "api.dexscreener.com") {
      const want = new Set(u.pathname.split("/").pop()!.split(","));
      const pairs = DEX.pairs.filter((p) => want.has(p.pairAddress)).map((p) => (o.h1Override?.[p.pairAddress] !== undefined ? { ...p, volume: { ...p.volume, h1: o.h1Override[p.pairAddress] } } : p));
      return json({ schemaVersion: "1.0.0", pairs });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const base = (o: Partial<HotMetrics> = {}): HotMetrics =>
  hotMetrics({ vol1hUsd: 20_000, vol5mUsd: 1_666, vol24hUsd: 480_000, liquidityUsd: 200_000, feePct: 1, buys1h: 50, sells1h: 50, buys5m: 5, sells5m: 5, priceChange5mPct: 0, priceChange1hPct: 0, priceChange24hPct: 0, ageHours: 100, ...o });
const ENV = { minLiquidityUsd: 20_000, minAgeHours: 12 };
const heat = (o: Partial<HotMetrics> = {}) => heatOf(base(o), ENV);

async function main(): Promise<void> {
  console.log("hot watch");

  /* ---------- env ---------- */
  await test("hotEnv: defaults, overrides, blanks and junk fall back", () => {
    const d = hotEnv({});
    assert.deepEqual(d, { intervalSec: 120, minLiquidityUsd: 20_000, minAgeHours: 12, surgeDailyPct: 5, maxRows: 60, boardTop: 150,
      geckoterminal: false, onchainReads: 8, siblingMinVol24hUsd: 500_000, siblingLookups: 6, siblingTtlMin: 30, pumpswapPages: 1 });
    const e = hotEnv({ HOT_INTERVAL_SEC: "30", HOT_MIN_LIQUIDITY_USD: "", HOT_MAX_ROWS: "abc", HOT_ONCHAIN_READS: "2", HOT_SIBLING_LOOKUPS: "0", HOT_SIBLING_TTL_MIN: "junk" });
    assert.equal(e.intervalSec, 30);
    assert.equal(e.minLiquidityUsd, 20_000);
    assert.equal(e.maxRows, 60);
    assert.equal(e.onchainReads, 2);
    assert.equal(e.siblingLookups, 0);
    assert.equal(e.siblingTtlMin, 30);
  });

  /* ---------- metric math ---------- */
  await test("hotMetrics: EMBER / USDC by hand (vol 1h $795,383, liquidity $1.067M, fee 2%)", () => {
    const m = hotMetrics({ vol1hUsd: 795383.42, vol5mUsd: 42580.61, vol24hUsd: 14097354.03, liquidityUsd: 1066950.47, feePct: 2, buys1h: 970, sells1h: 803, buys5m: 91, sells5m: 67, priceChange5mPct: -1.06, priceChange1hPct: 6.74, priceChange24hPct: 62.51, ageHours: 77 });
    near(m.fees1hUsd, 15907.67, 1e-4);
    near(m.feeToTvl1hPct, 1.4909, 1e-3);
    near(m.feeToTvlDailyPct, 35.78, 1e-3);
    near(m.turnover1h, 0.7455, 1e-3);
    near(m.acceleration, 1.354, 1e-3);
    near(m.sellShare1h, 803 / 1773, 1e-3);
    near(m.sellShare5m, 67 / 158, 1e-3);
  });
  await test("hotMetrics: nulls stay null (no fee, no liquidity, no 24h volume, no counts)", () => {
    const m = hotMetrics({ vol1hUsd: 1000, vol5mUsd: null, vol24hUsd: 0, liquidityUsd: 0, feePct: null, buys1h: null, sells1h: null, buys5m: 0, sells5m: 0, priceChange5mPct: null, priceChange1hPct: null, priceChange24hPct: null, ageHours: null });
    assert.equal(m.fees1hUsd, null);
    assert.equal(m.feeToTvl1hPct, null);
    assert.equal(m.feeToTvlDailyPct, null);
    assert.equal(m.turnover1h, null);
    assert.equal(m.acceleration, null);
    assert.equal(m.sellShare1h, null);
    assert.equal(m.sellShare5m, null);
    const n = hotMetrics({ vol1hUsd: 1000, vol5mUsd: null, vol24hUsd: null, liquidityUsd: 100_000, feePct: 0.5, buys1h: 0, sells1h: 0, buys5m: null, sells5m: null, priceChange5mPct: null, priceChange1hPct: null, priceChange24hPct: null, ageHours: null });
    near(n.fees1hUsd, 5);
    near(n.feeToTvl1hPct, 0.005);
    near(n.feeToTvlDailyPct, 0.12);
    assert.equal(n.acceleration, null);
    assert.equal(n.sellShare1h, null);
  });

  /* ---------- heat ---------- */
  await test("heat: more fee yield per dollar ranks higher; more liquidity at the same yield ranks higher", () => {
    const a = heat({ vol1hUsd: 20_000 }).heat;
    const b = heat({ vol1hUsd: 60_000 }).heat;
    const c = heat({ vol1hUsd: 60_000, liquidityUsd: 600_000 }).heat;
    assert.ok(b > a, `${b} > ${a}`);
    assert.ok(c > a && c < b, `${a} < ${c} < ${b}: same fee yield as a on a deeper pool; a third of b's yield`);
    const same = base({ vol1hUsd: 60_000, liquidityUsd: 600_000 });
    const smaller = base({ vol1hUsd: 20_000, liquidityUsd: 200_000 });
    assert.equal(same.feeToTvlDailyPct, smaller.feeToTvlDailyPct);
    assert.ok(heatOf(same, ENV).heat > heatOf(smaller, ENV).heat, "deeper pool wins at equal yield");
    assert.ok(c > 0 && c <= 100);
    // $8.4M through a $2M pool at 1% in one hour is a 4.2% hour, 100.8% a day: the scale saturates.
    const deep = base({ vol1hUsd: 8_400_000, liquidityUsd: 2_000_000, vol24hUsd: 201_600_000, vol5mUsd: 700_000 });
    near(deep.feeToTvlDailyPct, 100.8);
    assert.equal(heatOf(deep, ENV).heat, 100, "100%/day on a deep pool saturates");
    near(heat({ vol1hUsd: 20_000 }).heat, 100 * (Math.log10(3.4) / Math.log10(101)) * (0.6 + 0.4 * (Math.log10(10) / Math.log10(25))), 1e-3);
    assert.deepEqual(heat().flags, []);
  });
  await test("a Meteora board row is priced at base + variable (22 Sep review M9): a 1% pool that has moved is not read at a sliver of its fee, and outranks a 0.01% pool with the same flow", () => {
    const sParams = { baseFactor: 10_000, baseFeePowerFactor: 0, variableFeeControl: 7_500 } as never;
    const moved = boardRow({ address: "M1", name: "MEME / SOL", venue: "meteora-dlmm", rank: 3, ...meteoraBoardFees(100, sParams, { volatilityAccumulator: 1_000 } as never) });
    // the scan stores the fee a trader pays now
    near(moved.dynamicFeePct, 1.000075, 1e-12);
    near(boardFee(moved), 1.000075, 1e-12);
    // the board as it was written before the fix: the variable part alone
    // a stale row reads at its base, never at 0.000075%
    near(boardFee({ ...moved, dynamicFeePct: 0.000075 }), 1, 1e-12);
    const thin = boardRow({ address: "M2", name: "LOW / SOL", venue: "meteora-dlmm", rank: 4, baseFeePct: 0.01, dynamicFeePct: 0.01 });
    const hot = heat({ feePct: boardFee(moved) });
    const cool = heat({ feePct: boardFee(thin) });
    assert.ok(hot.heat > cool.heat, `${hot.heat} > ${cool.heat}`);
  });
  await test("heat: a pool with no fee is ordered by turnover, flagged fee-unknown, and loses to a known fee", () => {
    const known = heat({ feePct: 0.25 });
    const unknown = heat({ feePct: null });
    assert.deepEqual(unknown.flags, ["fee-unknown"]);
    assert.equal(unknown.excluded, false);
    assert.ok(unknown.heat > 0 && unknown.heat < known.heat, `${unknown.heat} < ${known.heat}`);
  });
  await test("flag thin: under the liquidity floor is a hard exclude", () => {
    const h = heat({ liquidityUsd: 19_999 });
    assert.deepEqual(h, { heat: 0, flags: ["thin"], excluded: true });
    assert.equal(heat({ liquidityUsd: 20_000 }).excluded, false);
    assert.equal(heatOf(base({ liquidityUsd: null }), ENV).excluded, true);
  });
  await test("flag no-1h-data: no last-hour volume is a hard exclude", () => {
    assert.deepEqual(heat({ vol1hUsd: null }), { heat: 0, flags: ["no-1h-data"], excluded: true });
  });
  await test("flag new: under HOT_MIN_AGE_HOURS brakes and flags; unknown age brakes a little without a flag", () => {
    const young = heat({ ageHours: 11.9 });
    const old = heat({ ageHours: 12 });
    const unknown = heat({ ageHours: null });
    assert.deepEqual(young.flags, ["new"]);
    assert.deepEqual(old.flags, []);
    assert.deepEqual(unknown.flags, []);
    assert.ok(young.heat < unknown.heat && unknown.heat < old.heat);
  });
  await test("flag dumping: sells over 65% of the hour with a falling price; not when the price held", () => {
    assert.deepEqual(heat({ buys1h: 30, sells1h: 70, priceChange1hPct: -3 }).flags, ["dumping"]);
    assert.deepEqual(heat({ buys1h: 30, sells1h: 70, priceChange1hPct: 3 }).flags, []);
    assert.deepEqual(heat({ buys1h: 40, sells1h: 60, priceChange1hPct: -3 }).flags, []);
    assert.ok(heat({ buys1h: 30, sells1h: 70, priceChange1hPct: -3 }).heat < heat().heat);
  });
  await test("flag wild: more than 15% moved in the hour, either way", () => {
    assert.deepEqual(heat({ priceChange1hPct: 15.1 }).flags, ["wild"]);
    assert.deepEqual(heat({ priceChange1hPct: -15.1 }).flags, ["wild"]);
    assert.deepEqual(heat({ priceChange1hPct: 15 }).flags, []);
    assert.deepEqual(heat({ buys1h: 30, sells1h: 70, priceChange1hPct: -20 }).flags, ["dumping", "wild"]);
  });
  await test("flag fading: five-minute volume near zero after a busy hour", () => {
    assert.deepEqual(heat({ vol5mUsd: 100 }).flags, ["fading"], "100 < 20000/12 x 0.15 = 250");
    assert.deepEqual(heat({ vol5mUsd: 300 }).flags, []);
    assert.deepEqual(heat({ vol5mUsd: null }).flags, []);
    assert.deepEqual(heat({ vol1hUsd: 9_000, vol5mUsd: 0, liquidityUsd: 100_000 }).flags, [], "a quiet hour is not a fade");
    assert.ok(heat({ vol5mUsd: 100 }).heat < heat().heat);
  });

  /* ---------- surge detection ---------- */
  const tape = (rows: Array<Partial<HotHistoryRow> & Pick<HotHistoryRow, "ts" | "address" | "heat">>): HotHistoryRow[] =>
    rows.map((r) => ({ venue: "x", vol1hUsd: null, vol5mUsd: null, liquidityUsd: null, feeToTvl1hPct: null, sellShare1h: null, priceChange1hPct: null, ...r }));
  const opts = { surgeDailyPct: 5, now: NOW };
  await test("surge A: daily pace crosses the line with acceleration >= 2; no crossing when it was already above", () => {
    const rows = [{ address: "A", feeToTvlDailyPct: 10, acceleration: 3 }];
    const seenA = tape([{ ts: NOW - H, address: "A", heat: 50 }]);
    assert.deepEqual(detectSurges(rows, seenA, opts), [{ address: "A", rule: "yield" }], "last tape row had no fee figure: counts as below");
    const below = tape([{ ts: NOW - H, address: "A", heat: 50, feeToTvl1hPct: 0.1 }]);
    assert.deepEqual(detectSurges(rows, below, opts), [{ address: "A", rule: "yield" }], "2.4%/day -> 10%/day");
    const above = tape([{ ts: NOW - H, address: "A", heat: 50, feeToTvl1hPct: 0.3 }]);
    assert.deepEqual(detectSurges(rows, above, opts), [], "7.2%/day -> 10%/day is no crossing, and A sat in a top 10 already");
    assert.deepEqual(detectSurges([{ address: "A", feeToTvlDailyPct: 10, acceleration: 1.9 }], below, opts), [], "acceleration under 2");
    assert.deepEqual(detectSurges([{ address: "A", feeToTvlDailyPct: 4.9, acceleration: 3 }], below, opts), [], "under the line");
    assert.deepEqual(detectSurges([{ address: "A", feeToTvlDailyPct: null, acceleration: 3 }], below, opts), [], "no fee figure, no yield surge");
  });
  await test("surge B: first time in the top 10 in the trailing 6 hours, on a synthetic tape", () => {
    // Two earlier ticks of 12 pools each: P0..P11 by heat, so P10 and P11 sat at 11th and 12th.
    const earlier: HotHistoryRow[] = [];
    for (const ts of [NOW - 5 * H, NOW - 2 * 60e3]) for (let i = 0; i < 12; i++) earlier.push(...tape([{ ts, address: `P${i}`, heat: 100 - i }]));
    const seen = topTenSeen(earlier);
    assert.equal(seen.size, 10);
    assert.ok(seen.has("P9") && !seen.has("P10"));
    const now = Array.from({ length: 12 }, (_, i) => ({ address: `P${i}`, feeToTvlDailyPct: null, acceleration: null }));
    // P10 climbs to 3rd: it is new to the top 10. P2 drops to 11th: it never fires from there.
    const climbed = [now[0], now[1], now[10], now[3], now[4], now[5], now[6], now[7], now[8], now[9], now[2], now[11]];
    assert.deepEqual(detectSurges(climbed, earlier, opts), [{ address: "P10", rule: "top10" }]);
    // Seen in a top 10 only 7 hours ago: outside the window, so it fires again.
    const stale = tape([{ ts: NOW - 7 * H, address: "P10", heat: 99 }, { ts: NOW - 7 * H, address: "P0", heat: 98 }]);
    assert.deepEqual(detectSurges([now[10]], stale, opts), [{ address: "P10", rule: "top10" }]);
    // The current tick's own rows on the tape (ts >= now) do not count as history.
    const self = tape([{ ts: NOW, address: "P10", heat: 99 }]);
    assert.deepEqual(detectSurges([now[10]], self, opts), [{ address: "P10", rule: "top10" }]);
    // Empty tape: everything in the top 10 fires, the 11th does not.
    const fresh = detectSurges(now.slice(0, 11), [], opts);
    assert.equal(fresh.length, 10);
    assert.ok(fresh.every((s) => s.rule === "top10") && !fresh.some((s) => s.address === "P10"));
    // A yield surge on a pool already in the top 10 reports as yield, not top10.
    const both = detectSurges([{ address: "P0", feeToTvlDailyPct: 12, acceleration: 2 }], earlier, opts);
    assert.deepEqual(both, [{ address: "P0", rule: "yield" }]);
  });

  /* ---------- hotPicks ---------- */
  const hotRow = (o: Partial<HotRow> & Pick<HotRow, "address" | "venue" | "heat">): HotRow => ({
    name: o.address, baseMint: "", baseSymbol: "", quoteMint: SOL, quoteSymbol: "SOL", priceUsd: null, marketCapUsd: null, priceNative: null, origin: null, onBoard: false, screenRank: null, stock: null, vol1hUsd: 1, vol5mUsd: 1, vol24hUsd: 1, liquidityUsd: 100_000, feePct: 1, feeSource: "board", fees1hUsd: 1,
    feeToTvl1hPct: 1, feeToTvlDailyPct: 24, turnover1h: 1, acceleration: 1, buys1h: 1, sells1h: 1, buys5m: 1, sells5m: 1, sellShare1h: 0.5, sellShare5m: 0.5, priceChange5mPct: 0, priceChange1hPct: 0, priceChange24hPct: 0, ageHours: 100,
    flags: [], surge: false, surgeAt: null, firstSeenAt: "", lastSeenAt: "", ...o,
  });
  await test("hotPicks: tradable venue, SOL or USDC quote, no new/dumping/wild, liquidity floor, best heat first, capped", () => {
    const hot: HotFile = {
      generatedAt: "", tickMs: 0, sources: { trending: 0, dexscreener: 0, onchainReads: 0, errors: [] },
      rows: [
        hotRow({ address: "orca", venue: "orca-whirlpool", heat: 99 }),
        hotRow({ address: "zec-quote", venue: "meteora-dlmm", heat: 98, quoteSymbol: "ZEC", quoteMint: "x" }),
        hotRow({ address: "new", venue: "meteora-dlmm", heat: 97, flags: ["new"] }),
        hotRow({ address: "dumping", venue: "meteora-dlmm", heat: 96, flags: ["dumping"] }),
        hotRow({ address: "wild", venue: "meteora-dlmm", heat: 95, flags: ["wild"] }),
        hotRow({ address: "thin", venue: "meteora-dlmm", heat: 94, liquidityUsd: 19_000 }),
        hotRow({ address: "cold", venue: "meteora-dlmm", heat: 0 }),
        hotRow({ address: "low", venue: "meteora-dlmm", heat: 10, quoteSymbol: "USDC", quoteMint: USDC }),
        hotRow({ address: "fading-ok", venue: "meteora-dlmm", heat: 40, flags: ["fading"] }),
        hotRow({ address: "high", venue: "meteora-dlmm", heat: 60 }),
      ],
    };
    const tradable = (r: HotRow) => r.venue === "meteora-dlmm";
    assert.deepEqual(hotPicks(hot, { tradable, max: 5, minLiquidityUsd: 20_000 }).map((r) => r.address), ["high", "fading-ok", "low"]);
    assert.deepEqual(hotPicks(hot, { tradable, max: 2, minLiquidityUsd: 20_000 }).map((r) => r.address), ["high", "fading-ok"]);
    assert.deepEqual(hotPicks(hot, { tradable: () => true, max: 1, minLiquidityUsd: 20_000 }).map((r) => r.address), ["orca"]);
    assert.deepEqual(hotPicks(null, { tradable }), []);
  });

  /* ---------- parsing ---------- */
  await test("parseTrending: GeckoTerminal trending rows -> samples (STONK / SOL on Meteora DLMM)", () => {
    const rows = parseTrending(TRENDING_5M);
    assert.equal(rows.length, 3);
    const s = rows.find((r) => r.address === STONK_SOL)!;
    assert.equal(s.source, "trending");
    assert.equal(s.name, "STONK / SOL");
    assert.equal(s.venue, "meteora-dlmm");
    assert.equal(s.baseMint, "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx");
    assert.equal(s.quoteMint, SOL);
    assert.equal(s.baseSymbol, "STONK");
    assert.equal(s.quoteSymbol, "SOL");
    near(s.liquidityUsd, 2825964.6374);
    near(s.vol5mUsd, 37110.6689539281);
    near(s.vol1hUsd, 721653.293601921);
    near(s.vol24hUsd, 26867197.6298484);
    assert.equal(s.buys5m, 85);
    assert.equal(s.sells5m, 28);
    assert.equal(s.buys1h, 705);
    assert.equal(s.sells1h, 245);
    near(s.priceChange5mPct, 0.203);
    near(s.priceChange1hPct, -2.495);
    near(s.priceChange24hPct, -2.431);
    near(s.priceUsd, 0.2673600539);
    near(s.quotePriceUsd, 99.7757213356);
    assert.equal(s.createdAt, Date.parse("2026-08-12T10:51:40Z"));
    const j = rows.find((r) => r.address === JUBJUB_ZEC)!;
    assert.equal(j.venue, "raydium");
    assert.equal(j.quoteSymbol, "ZEC");
    assert.equal(rows.find((r) => r.address === MIZO_SOL)!.venue, "pumpswap");
    const h1 = parseTrending(TRENDING_1H);
    assert.equal(h1.find((r) => r.address === ZEC_ZCAT)!.venue, "raydium-clmm");
    assert.equal(h1.find((r) => r.address === EMBER_USDC)!.quoteSymbol, "USDC");
    assert.deepEqual(parseTrending({}), []);
    assert.deepEqual(parseTrending(null), []);
  });
  await test("parseDexScreener: pairs -> samples, labels tell the program apart (wp, CLMM, DLMM, CPMM)", () => {
    const rows = parseDexScreener(DEX);
    assert.equal(rows.length, 6);
    const e = rows.find((r) => r.address === EMBER_SOL)!;
    assert.equal(e.source, "dexscreener");
    assert.equal(e.venue, "orca-whirlpool");
    assert.equal(e.name, "EMBER / SOL");
    assert.equal(e.baseSymbol, "EMBER");
    assert.equal(e.quoteSymbol, "SOL");
    assert.equal(e.baseMint, "5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6");
    near(e.liquidityUsd, 426872.27);
    near(e.vol5mUsd, 12273.7);
    near(e.vol1hUsd, 87330.71);
    near(e.vol24hUsd, 3671325.07);
    assert.equal(e.buys5m, 0);
    assert.equal(e.sells5m, 13);
    assert.equal(e.buys1h, 105);
    assert.equal(e.sells1h, 30);
    near(e.priceChange5mPct, -2.46);
    near(e.priceChange1hPct, 1.74);
    near(e.priceUsd, 0.03596);
    assert.equal(e.quotePriceUsd, null);
    assert.equal(e.createdAt, 1788996264000);
    const d = rows.find((r) => r.address === DKNG_USDC)!;
    assert.equal(d.venue, "raydium-clmm");
    assert.equal(d.quoteSymbol, "USDC");
    assert.equal(d.priceChange5mPct, null, "DexScreener omits m5 when nothing traded");
    assert.equal(rows.find((r) => r.address === ANSEM_SOL)!.venue, "meteora-dlmm");
    assert.equal(rows.find((r) => r.address === JUBJUB_ZEC)!.venue, "raydium-cpmm");
    assert.deepEqual(parseDexScreener({ pairs: null }), []);
  });
  await test("venueOfDex: both sources' ids map to our venue names, the rest stay verbatim", () => {
    assert.equal(venueOfDex("meteora"), "meteora-dlmm");
    assert.equal(venueOfDex("meteora", ["DLMM"]), "meteora-dlmm");
    assert.equal(venueOfDex("meteora", ["DAMM v2"]), "meteora-damm-v2");
    assert.equal(venueOfDex("meteora-damm-v2"), "meteora-damm-v2");
    assert.equal(venueOfDex("raydium-clmm"), "raydium-clmm");
    assert.equal(venueOfDex("raydium", ["CLMM"]), "raydium-clmm");
    assert.equal(venueOfDex("raydium", ["CPMM"]), "raydium-cpmm");
    assert.equal(venueOfDex("raydium"), "raydium");
    assert.equal(venueOfDex("orca"), "orca-whirlpool");
    assert.equal(venueOfDex("Orca", ["wp"]), "orca-whirlpool");
    assert.equal(venueOfDex("pumpswap"), "pumpswap");
    assert.equal(venueOfDex("humidifi"), "humidifi");
  });
  await test("splitName, quoteSymbolOf, flipPct, orient", () => {
    assert.deepEqual(splitName("SOL / USDC 0.04%"), { base: "SOL", quote: "USDC" });
    assert.deepEqual(splitName("JubJub / ZEC"), { base: "JubJub", quote: "ZEC" });
    assert.deepEqual(splitName("weird"), { base: "weird", quote: null });
    assert.deepEqual(splitName(null), { base: null, quote: null });
    assert.equal(quoteSymbolOf(SOL, "WSOL"), "SOL");
    assert.equal(quoteSymbolOf(USDC, "USD Coin"), "USDC");
    assert.equal(quoteSymbolOf("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", "ZEC"), "ZEC");
    assert.equal(quoteSymbolOf("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", null), "A7bd…QXaS");
    near(flipPct(100), -50);
    near(flipPct(-50), 100);
    assert.equal(flipPct(null), null);
    assert.equal(flipPct(-100), null);
    const s = parseDexScreener(DEX).find((r) => r.address === EMBER_SOL)!;
    assert.equal(orient(s, s.baseMint!), s, "same orientation: untouched");
    const flipped = orient(s, SOL);
    near(flipped.priceChange1hPct, 100 / 1.0174 - 100);
    near(flipped.vol1hUsd, 87330.71, 1e-9);
  });
  await test("identityOf / inputsOf: the board wins, then GeckoTerminal, then DexScreener; numbers DexScreener first", () => {
    const t = parseTrending(TRENDING_5M).find((r) => r.address === STONK_SOL)!;
    const d = parseDexScreener(DEX).find((r) => r.address === STONK_SOL)!;
    const b = SCREEN.pools[0];
    assert.equal(identityOf(b, t, d)!.name, "EMBER / SOL");
    assert.equal(identityOf(b, t, d)!.venue, "orca-whirlpool");
    assert.deepEqual(identityOf(undefined, t, d), { name: "STONK / SOL", venue: "meteora-dlmm", baseMint: t.baseMint, baseSymbol: "STONK", quoteMint: SOL, quoteSymbol: "SOL" });
    assert.equal(identityOf(undefined, undefined, d)!.name, "STONK / SOL");
    assert.equal(identityOf(undefined, undefined, undefined), null);
    const nameless: PoolSample = { ...t, name: null, baseSymbol: null, quoteSymbol: null };
    assert.equal(identityOf(undefined, nameless, d)!.baseSymbol, "STONK", "symbols fall through to the other source");
    const i = inputsOf(d, t, 0.2, 500);
    near(i.vol1hUsd, 753610.54, 1e-9);
    assert.equal(i.feePct, 0.2);
    assert.equal(i.ageHours, 500);
    const j = inputsOf({ ...d, vol5mUsd: null, buys1h: null }, t, null, null);
    near(j.vol5mUsd, 37110.6689539281, 1e-9);
    assert.equal(j.buys1h, 705);
    assert.equal(inputsOf(undefined, undefined, null, null).vol1hUsd, null);
  });
  await test("solPriceFromSamples, boardTop, heldPools, parseHistory", () => {
    near(solPriceFromSamples(parseTrending(TRENDING_5M)), 99.7757213356);
    near(solPriceFromSamples(parseTrending(TRENDING_1H)), 99.7431304767, 1e-6);
    assert.equal(solPriceFromSamples(parseDexScreener(DEX).filter((s) => s.quoteMint !== SOL)), null);
    const top = boardTop({ ...SCREEN, pools: [SCREEN.pools[1], SCREEN.pools[0]] }, 1);
    assert.deepEqual([...top.keys()], [EMBER_SOL]);
    assert.equal(boardTop(null, 5).size, 0);
    const entries = [
      { pool: { address: "A" }, positions: [] },
      { pool: { address: "B" }, positions: [{}] },
      { pool: { address: "A" }, positions: [{}] },
      { pool: { address: "B" }, positions: [] },
      { pool: { address: "" }, positions: [{}] },
    ];
    assert.deepEqual(heldPools(entries), ["B"], "the newest entry per pool decides");
    assert.deepEqual(heldPools([]), []);
    const text = `{"ts":1,"address":"cut"\n{"ts":${NOW - 1},"address":"old","heat":1}\n{"ts":${NOW},"address":"now","heat":2}\nnot json\n{"ts":${NOW + 1},"address":"next","heat":3}\n`;
    assert.deepEqual(parseHistory(text, NOW).map((r) => r.address), ["now", "next"]);
  });

  /* ---------- a whole tick, twice, on a fake fetch ---------- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-hot-"));
  // siblingLookups 0 and pumpswapPages 0: these tests pin the tick's exact call budget. Sibling discovery has its own
  // tests (npm run test:launch); the PumpSwap source is pinned on its own below, with its call counted.
  const env = { minLiquidityUsd: 20_000, minAgeHours: 12, surgeDailyPct: 5, maxRows: 60, boardTop: 150,
      geckoterminal: true, onchainReads: 2, siblingLookups: 0, pumpswapPages: 0 };
  const feeCache = new Map<string, FeeCacheEntry>();
  const feeReads: string[] = [];
  const readFee = async (address: string, solPriceUsd: number | null) => {
    feeReads.push(address);
    assert.equal(solPriceUsd, 99.81, "the board's SOL price reaches the on-chain read");
    if (address === EMBER_USDC) return 2;
    if (address === STONK_SOL) return 0.2;
    throw new Error("unexpected read");
  };
  let first: HotFile;
  await test("runHotTick: board + held + trending through DexScreener, fees from the board or a capped live read, no network", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    first = await runHotTick({ dataDir: dir, env, screen: SCREEN, held: [ANSEM_SOL], now: NOW, fetchImpl: fakeFetch({ calls }), sleep: async () => {}, readFee, feeCache, log: (s) => logs.push(s) });
    assert.deepEqual(calls.slice(0, 2), [TRENDING_URL("5m"), TRENDING_URL("1h")]);
    assert.equal(calls.length, 3, "two trending calls and one DexScreener batch (8 addresses < 30)");
    assert.equal(calls[2], DEXSCREENER_URL([EMBER_SOL, DKNG_USDC, ANSEM_SOL, JUBJUB_ZEC, STONK_SOL, MIZO_SOL, EMBER_USDC, ZEC_ZCAT, SOL_USDC]), "board first, then held, then trending, deduplicated");
    assert.equal(first.generatedAt, new Date(NOW).toISOString());
    assert.deepEqual(first.sources, { trending: 6, dexscreener: 6, onchainReads: 2, siblingLookups: 0, siblingRows: 0, pumpswap: 0, errors: [] });
    const stonkRow = first.rows.find((r) => r.address === STONK_SOL)!;
    assert.equal(stonkRow.priceNative, 0.002711, "quote per base from DexScreener's priceNative");
    assert.equal(stonkRow.priceUsd, 0.2704);
    assert.equal(stonkRow.origin, null, "STONK is not a pump.fun token");
    assert.deepEqual(feeReads, [EMBER_USDC, STONK_SOL], "the two highest-turnover Meteora pools off the board; ANSEM waits for the cap");

    const names = first.rows.map((r) => r.name);
    assert.deepEqual(names, ["EMBER / USDC", "EMBER / SOL", "STONK / SOL", "MIZO / SOL", "JubJub / ZEC", "ZEC / ZCAT", "SOL / USDC", "ANSEM / SOL"]);
    assert.ok(!first.rows.some((r) => r.address === DKNG_USDC), "DKNG / USDC is thin: excluded");
    for (let i = 1; i < first.rows.length; i++) assert.ok(first.rows[i - 1].heat >= first.rows[i].heat, "best heat first");

    const ember = first.rows[0];
    assert.equal(ember.venue, "meteora-dlmm");
    assert.equal(ember.onBoard, false);
    assert.equal(ember.feePct, 2);
    assert.equal(ember.feeSource, "onchain");
    near(ember.feeToTvl1hPct, 1.4909, 1e-3);
    near(ember.feeToTvlDailyPct, 35.78, 1e-3);
    near(ember.acceleration, 1.354, 1e-3);
    near(ember.ageHours, (NOW - 1789019630000) / H, 1e-2);
    assert.equal(ember.quoteSymbol, "USDC");
    assert.deepEqual(ember.flags, []);
    near(ember.heat, 78.1, 2e-2);

    const emberSol = first.rows[1];
    assert.equal(emberSol.onBoard, true);
    assert.equal(emberSol.screenRank, 1);
    assert.equal(emberSol.venue, "orca-whirlpool");
    assert.equal(emberSol.feePct, 2.0103, "the board's dynamic fee");
    assert.equal(emberSol.feeSource, "board");
    near(emberSol.feeToTvlDailyPct, ((87330.71 * 0.020103) / 426872.27) * 100 * 24, 1e-3);
    near(emberSol.heat, 50.7, 2e-2);

    const stonk = first.rows[2];
    assert.equal(stonk.feePct, 0.2);
    assert.equal(stonk.feeSource, "onchain");
    near(stonk.vol1hUsd, 753610.54, 1e-9);
    assert.equal(stonk.quoteSymbol, "SOL");

    const mizo = first.rows.find((r) => r.address === MIZO_SOL)!;
    assert.equal(mizo.venue, "pumpswap");
    assert.equal(mizo.feePct, null);
    assert.deepEqual(mizo.flags, ["fee-unknown", "new", "wild"]);
    near(mizo.vol1hUsd, 354580.661998471, 1e-9);
    const jub = first.rows.find((r) => r.address === JUBJUB_ZEC)!;
    assert.equal(jub.venue, "raydium", "GeckoTerminal named it first");
    assert.equal(jub.quoteSymbol, "ZEC");
    assert.deepEqual(jub.flags, ["fee-unknown", "new", "wild"]);
    const ansem = first.rows.find((r) => r.address === ANSEM_SOL)!;
    assert.equal(ansem.onBoard, false);
    assert.equal(ansem.venue, "meteora-dlmm", "DexScreener's DLMM label");
    assert.deepEqual(ansem.flags, ["fee-unknown"]);

    assert.ok(first.rows.every((r) => r.surge && r.surgeAt === first.generatedAt), "an empty tape: every row in the top 10 fires");
    assert.ok(first.rows.every((r) => r.firstSeenAt === first.generatedAt && r.lastSeenAt === first.generatedAt));
    assert.ok(logs.some((l) => l.startsWith("[hot] 8 rows · trending 6 · dexscreener 6/9 · onchain 2 · 8 surges")), logs.join("\n"));
    assert.equal(logs.filter((l) => l.startsWith("[hot] SURGE ")).length, 8);
    assert.ok(logs.some((l) => l.includes("SURGE EMBER / USDC · meteora-dlmm · top10 · liq $1.07M · vol 1h $795.4K · fee 2.00% · fee/TVL 1h 1.49% · daily 35.8% · accel 1.4x · sells 45% · 1h +6.7%")), logs.join("\n"));

    const tapeRows = readHistoryTail(dir, 0);
    assert.equal(tapeRows.length, 8);
    assert.deepEqual(Object.keys(tapeRows[0]), ["ts", "address", "venue", "vol1hUsd", "vol5mUsd", "liquidityUsd", "feeToTvl1hPct", "sellShare1h", "priceChange1hPct", "heat", "surge"]);
    assert.equal(tapeRows[0].ts, NOW);
  });
  await test("second tick: fee cache holds, the deferred read happens, surges do not refire, the badge stays sticky, firstSeenAt carries", async () => {
    feeReads.length = 0;
    const logs: string[] = [];
    const second = await runHotTick({ dataDir: dir, env, screen: SCREEN, held: [ANSEM_SOL], now: NOW + 2 * 60e3, fetchImpl: fakeFetch(), sleep: async () => {}, readFee: async (a) => (a === ANSEM_SOL ? 0.5 : readFee(a, 99.81)), feeCache, log: (s) => logs.push(s) });
    assert.deepEqual(feeReads, [], "EMBER / USDC and STONK came from the cache");
    assert.equal(second.sources.onchainReads, 1, "ANSEM got its read now that the cap allows");
    const ansem = second.rows.find((r) => r.address === ANSEM_SOL)!;
    assert.equal(ansem.feePct, 0.5);
    assert.deepEqual(ansem.flags, []);
    assert.ok(logs.some((l) => l.includes(" · 0 surges")), logs.join("\n"));
    assert.ok(second.rows.every((r) => r.surge && r.surgeAt === first.generatedAt), "sticky for 30 minutes, stamped with the tick that fired");
    assert.ok(second.rows.every((r) => r.firstSeenAt === first.generatedAt && r.lastSeenAt === second.generatedAt));
    assert.equal(readHistoryTail(dir, 0).length, 16);
    assert.ok(readHistoryTail(dir, 0).slice(8).every((r) => r.surge === undefined), "the tape marks only the firing tick");
  });
  await test("third tick: a volume jump on STONK crosses 5%/day at 4x the day's pace -> a yield SURGE; the sticky badge lapses after 30 min", async () => {
    const logs: string[] = [];
    const later = NOW + 31 * 60e3;
    const third = await runHotTick({ dataDir: dir, env, screen: SCREEN, held: [ANSEM_SOL], now: later, fetchImpl: fakeFetch({ h1Override: { [STONK_SOL]: 5_000_000 } }), sleep: async () => {}, readFee, feeCache, log: (s) => logs.push(s) });
    const stonk = third.rows.find((r) => r.address === STONK_SOL)!;
    near(stonk.feeToTvlDailyPct, ((5_000_000 * 0.002) / 2841734.9) * 100 * 24, 1e-3);
    near(stonk.acceleration, (5_000_000 * 24) / 26876791.39, 1e-3);
    assert.equal(stonk.surge, true);
    assert.equal(stonk.surgeAt, third.generatedAt);
    assert.ok(logs.some((l) => l.includes("SURGE STONK / SOL · meteora-dlmm · yield ·")), logs.join("\n"));
    assert.ok(third.rows.filter((r) => r.address !== STONK_SOL).every((r) => !r.surge && r.surgeAt === null), "the first tick's badges lapsed");
    assert.equal(readHistoryTail(dir, later).filter((r) => r.surge).length, 1);
  });
  await test("a source that fails is named in sources.errors and the console; rows come from the ones that answered", async () => {
    const logs: string[] = [];
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-hot-"));
    const r = await runHotTick({ dataDir: d2, env, screen: SCREEN, held: [ANSEM_SOL], now: NOW, fetchImpl: fakeFetch({ failTrending: true }), sleep: async () => {}, readFee: async () => 0.5, log: (s) => logs.push(s) });
    assert.deepEqual(r.sources.errors, ["trending 5m: ECONNRESET", "trending 1h: ECONNRESET"]);
    assert.equal(r.sources.trending, 0);
    assert.equal(r.sources.dexscreener, 3);
    assert.deepEqual(r.rows.map((x) => x.name).sort(), ["ANSEM / SOL", "EMBER / SOL"]);
    assert.ok(logs.some((l) => l.includes("[hot] trending 5m: ECONNRESET")));
    assert.ok(logs.some((l) => l.includes("2 source errors")));
    fs.rmSync(d2, { recursive: true, force: true });
  });
  await test("the PumpSwap source: one page is one more GeckoTerminal call, its rows merge like trending rows, carry origin pump.fun and the quote price", async () => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-hot-"));
    const calls: string[] = [];
    const r = await runHotTick({ dataDir: d3, env: { ...env, pumpswapPages: 1 }, screen: SCREEN, held: [ANSEM_SOL], now: NOW, fetchImpl: fakeFetch({ calls }), sleep: async () => {}, readFee: async () => 0.5, log: () => {} });
    assert.deepEqual(calls.slice(0, 3), [TRENDING_URL("5m"), TRENDING_URL("1h"), PUMPSWAP_URL(1)], "trending, then the PumpSwap page, before DexScreener");
    assert.equal(calls.length, 4, "two trending calls, one PumpSwap page and one DexScreener batch (12 addresses < 30)");
    assert.equal(calls[3], DEXSCREENER_URL([EMBER_SOL, DKNG_USDC, ANSEM_SOL, JUBJUB_ZEC, STONK_SOL, MIZO_SOL, EMBER_USDC, ZEC_ZCAT, SOL_USDC, NVIDA_PUMP, CLAUDE_PUMP, NIKE_PUMP]), "the PumpSwap rows join the DexScreener refresh after the trending rows");
    assert.equal(r.sources.pumpswap, 3);
    assert.equal(r.sources.trending, 6, "PumpSwap rows are counted on their own, not as trending");
    const nike = r.rows.find((x) => x.address === NIKE_PUMP)!;
    assert.ok(nike, "the $344k NIKE/SOL PumpSwap pool reaches the board");
    assert.equal(nike.venue, "pumpswap");
    assert.equal(nike.origin, "pump.fun", "a pool on PumpSwap holds a pump.fun token even when the mint does not end in `pump`");
    assert.equal(nike.quoteSymbol, "SOL");
    assert.equal(nike.priceNative, 0.0000002912454749, "GeckoTerminal's base_token_price_quote_token fills in when DexScreener has no pair");
    assert.equal(nike.priceUsd, 3.0068211909455936e-05);
    assert.equal(nike.vol1hUsd, 12_394_850.3308151);
    assert.ok(nike.flags.includes("new"), "an hour old: the hot watch still flags it new");
    assert.ok(!r.rows.some((x) => x.address === NVIDA_PUMP || x.address === CLAUDE_PUMP), "drained pools (reserve under the liquidity floor) are excluded as ever");
    assert.equal(r.sources.errors.length, 0);
    // pages 2+ are paced and merged; a failing page is named and the tick still lands
    const calls2: string[] = [];
    const waits: number[] = [];
    const r2 = await runHotTick({ dataDir: d3, env: { ...env, pumpswapPages: 2 }, screen: SCREEN, held: [], now: NOW + 60e3, fetchImpl: fakeFetch({ calls: calls2 }), sleep: async (ms) => void waits.push(ms), readFee: async () => 0.5, log: () => {} });
    assert.deepEqual(calls2.slice(2, 4), [PUMPSWAP_URL(1), PUMPSWAP_URL(2)]);
    assert.ok(waits.includes(2200), "pages are paced like the trending calls");
    assert.equal(r2.sources.pumpswap, 3, "the empty second page adds nothing");
    const r3 = await runHotTick({ dataDir: d3, env: { ...env, pumpswapPages: 1 }, screen: SCREEN, held: [], now: NOW + 120e3, fetchImpl: fakeFetch({ failPumpswap: true }), sleep: async () => {}, readFee: async () => 0.5, log: () => {} });
    assert.deepEqual(r3.sources.errors, ["pumpswap page 1: HTTP 500"]);
    assert.equal(r3.sources.pumpswap, 0);
    assert.ok(r3.rows.length > 0, "the rest of the tick still lands");
    fs.rmSync(d3, { recursive: true, force: true });
  });
  await test("parsePumpSwapPools and originOf: the PumpSwap page is trending's shape, and origin follows the mint suffix or the venue", () => {
    const rows = parsePumpSwapPools(PUMPSWAP_P1);
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(r.source, "pumpswap");
    assert.equal(rows[2].venue, "pumpswap");
    assert.equal(rows[2].priceNative, 0.0000002912454749);
    assert.equal(rows[2].quotePriceUsd, 102.72384941936723);
    assert.equal(originOf("9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", "meteora-dlmm"), "pump.fun", "the mint suffix");
    assert.equal(originOf("FHDQkQtKVhjRMMTDDNfSyQq5tg5ADbQ1zmEv1k88V9pd", "pumpswap"), "pump.fun", "the venue");
    assert.equal(originOf("FHDQkQtKVhjRMMTDDNfSyQq5tg5ADbQ1zmEv1k88V9pd", "pump-fun"), "pump.fun");
    assert.equal(originOf("6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx", "meteora-dlmm"), null);
    assert.equal(originOf(null, "raydium"), null);
  });
  await test("fetchTrending: a 429 waits 20 s and retries the same call", async () => {
    const waits: number[] = [];
    const calls: string[] = [];
    const r = await fetchTrending(["5m", "1h"], { fetchImpl: fakeFetch({ calls, firstTrending429: true }), sleep: async (ms) => void waits.push(ms) });
    assert.equal(r.samples.length, 6);
    assert.equal(r.calls, 3);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(waits, [20_000, 2_200], "the back-off, then the pace between durations");
    assert.equal(calls[0], calls[1]);
  });

  /* ---------- files and the route ---------- */
  await test("loadHot round-trips data/hot.json; GET /api/hot serves it and 404s with a reason when absent", async () => {
    const onDisk = loadHot(dir);
    assert.ok(onDisk);
    assert.equal(onDisk!.rows.length, 8);
    assert.equal(onDisk!.rows[0].name, "EMBER / USDC");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-hot-"));
    assert.equal(loadHot(empty), null);
    const app = new Hono();
    hotRoutes(app, { dir: empty });
    const missing = await app.request("/api/hot");
    assert.equal(missing.status, 404);
    assert.equal(typeof ((await missing.json()) as { error: string }).error, "string");
    const app2 = new Hono();
    hotRoutes(app2, { dir });
    const res = await app2.request("/api/hot");
    assert.equal(res.status, 200);
    const body = (await res.json()) as HotFile;
    assert.deepEqual(body, onDisk);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  /* ---------- the scheduler ---------- */
  await test("startHotWatch: ticks never overlap, a throwing tick is caught, stop() halts it", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const logs: string[] = [];
    const tick = async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 12));
        if (calls === 2) throw new Error("boom");
      } finally {
        inFlight--;
      }
    };
    const w = startHotWatch({ intervalSec: 0.004, tick, log: (s) => logs.push(s) });
    assert.equal(w.lastTickAt, null);
    await new Promise((r) => setTimeout(r, 120));
    w.stop();
    // stop() arms no new tick but never aborts the one in flight: let it settle, then nothing else may start.
    while (w.running) await new Promise((r) => setTimeout(r, 5));
    const frozen = w.ticks;
    assert.ok(frozen >= 3, `ticks ${frozen}`);
    assert.equal(maxInFlight, 1);
    assert.equal(w.errors, 1);
    assert.ok(logs.some((l) => l === "[hot] tick failed: boom"));
    assert.ok(w.lastTickAt !== null && w.lastTickAt <= Date.now());
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(w.ticks, frozen, "no ticks after stop()");
    assert.equal(w.running, false);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  await test("the hot tape is rolled once it outgrows its cap, on a line boundary, and the surge window still reads back", async () => {
    const { appendHistory, HISTORY_FILE } = await import("../hot/store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tape-"));
    const row = (ts: number, address: string): HotHistoryRow => ({ ts, address, venue: "meteora-dlmm", vol5mUsd: 1, vol1hUsd: 1, liquidityUsd: 2, feeToTvl1hPct: 0.1, sellShare1h: 0.5, priceChange1hPct: 1, priceUsd: 3, heat: 4 }) as unknown as HotHistoryRow;
    // rolledTape is pure: under the cap it leaves the text alone, over it keeps the last half from a line boundary
    assert.equal(rolledTape("a\nb\nc\n", 1024), null);
    const many = Array.from({ length: 200 }, (_, i) => `line${i}`).join("\n") + "\n";
    const rolled = rolledTape(many, 400)!;
    assert.ok(rolled.length > 0 && rolled.length <= 200, `kept ${rolled.length} bytes of ${many.length}`);
    assert.ok(!rolled.startsWith("line") || /^line\d+\n/.test(rolled), "starts on a whole line");
    for (const l of rolled.split("\n").filter(Boolean)) assert.match(l, /^line\d+$/, `partial line survived: ${l}`);
    assert.ok(many.endsWith(rolled), "the tail is kept, not the head");
    // and end to end: append past a small cap, the file is capped and the newest rows are still readable
    const prev = process.env.HOT_TAPE_MAX_BYTES;
    process.env.HOT_TAPE_MAX_BYTES = "4096";
    try {
      const now = Date.now();
      for (let i = 0; i < 400; i++) appendHistory(dir, [row(now + i, `pool${i}`)]);
      const size = fs.statSync(HISTORY_FILE(dir)).size;
      assert.ok(size <= 4096, `tape is ${size} bytes, over the 4096 cap`);
      const back = readHistoryTail(dir, now);
      assert.ok(back.length > 0, "the tape still reads back after rolling");
      assert.equal(back[back.length - 1].address, "pool399", "the newest row survived the roll");
      for (const r of back) assert.equal(typeof r.ts, "number", "no torn row came back");
    } finally {
      if (prev === undefined) delete process.env.HOT_TAPE_MAX_BYTES;
      else process.env.HOT_TAPE_MAX_BYTES = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
