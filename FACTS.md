# Verified Facts — Robinhood Chain 4663 (as of 2026-09-10)

Everything here was verified on-chain via `cast` against the live RPC, or read from PONS source
(`ponsdotdev/ponsfamily` `contractsV2/src/v2`). This is the reference a builder needs. Re-verify
addresses before any mainnet write; factory addresses can change.

## Chain
- Chain id: 4663. RPC: `https://rpc.mainnet.chain.robinhood.com` (public, rate-limited).
- Alchemy RPC/bundler in `.env` as `ROBINHOOD_ALCHEMY_RPC` (`https://robinhood-mainnet.g.alchemy.com/v2/<key>`).
- Native gas token: ETH. Block time ~0.1s. Gas ~0.18 gwei. Arbitrum Orbit L2.
- Explorer: `https://robinhoodchain.blockscout.com` (Cloudflare-gated for scripted API). Multicall3: `0xca11bde05977b3631167028862be2a173976ca11`.

## PONS V2 launchpad
- Current V2 factory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`.
- Legacy V1 factory (WETH-only, do not use): `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`.
- Fee escrow (claim-based): `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`. Read live via `factory.feeEscrow()`.
- Launch fee: 0.0005 ETH (5e14 wei). Pool fee: 1%. Fee split: creator 70% / protocol 30%.
- Protocol fee use: 80% buys back PONS by TWAP, then burns.
- Launch config 0 (only config): supply 1e27 (1B x 1e18), curveFeeBps 100, phantomQuote 1.68e18,
  graduationThreshold 4.2e18 (native = wei), tickSpacing 200.
- Launch guard: 2-block window, max 5% hold / 5.5% buy per wallet.
- Pair tokens (V2 approved): native ETH via `pairToken=address(0)` (bypasses the approval check),
  USDG, cbBTC, ~54+ tokenized stocks. WETH is NOT approved on V2.
- `creatorFeeRecipient` accepts an ARBITRARY address (source-confirmed: nonzero used as-is, zero
  defaults to deployer). A recipient != deployer is auto-exempt from the snipe tax. The recipient
  can change itself via `factory.transferCreatorFeeRecipient(token, newRecipient)`.

### launchToken + TokenParams
```
launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)
// overload adds address[] snipeTaxExemptions; launchTokenFor(...,originalDeployer,...) for routers
```
TokenParams (order is load-bearing): name(string), symbol(string), logo(string), description(string),
socials(Socials), creatorFeeRecipient(address), creatorTaxBps(uint16 <=1000), buybackEnabled(bool),
expectedEconomics(bytes32; 0 waives), salt(bytes32).
Socials (5 string fields): twitter, telegram, discord, website, farcaster. Order matches the $REBOUND
byte-for-byte interface; an EMPTY-socials launch is proven in test/Phase0.fork.t.sol. Re-verify a
NON-empty socials launch against live source before mainnet.
Note: PONS create UI also has a native "Holder fee sharing" toggle (route creator fees to holders pro-rata).

### Fee model: accrue -> sweep -> claim (proven in Phase 0)
- Trades accrue on the curve: `quoteFeeBalance`, `creatorTaxBalance`, `buybackQuoteBalance` (public views).
- `sweepFees(uint256 minBuybackTokensOut)`: callable by the fee-sweep operator, or by the creator
  when no buyback swap is needed (buyback off). It credits the escrow.
- Escrow (`IPonsV2FeeEscrow`): `claim()`, `claim(uint256)`, `claimToken(address)`, `balanceOf(address)`,
  `balanceOfToken(address,address)`. Claim is msg.sender-based (you claim your own credited balance).
- Post-graduation: `PonsV2MemeHook.sweepPoolFees(poolId, minConversionQuoteOut, minBuybackTokensOut)`, same model.

### Curve interface (PonsV2BondingCurve)
```
buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)  // native: msg.value == quoteIn
sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)           // approve curve first
sweepFees(uint256 minBuybackTokensOut)
readyToGraduate() returns (bool)
```

## Account abstraction (all live on 4663)
- EntryPoints: v0.6 `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`, v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`,
  v0.8 `0x4337084D9E255Ff0702461Cf8895CE9E3b5Ff108`. All have code.
- Alchemy bundler live for 4663 (`eth_supportedEntryPoints`, `rundler_maxPriorityFeePerGas` both respond).
  ZeroDev also available. EIP-7702 supported. Embedded wallets: Privy, Dynamic.
- Design: agents pay their OWN gas from their treasury. No paymaster, no sponsorship.

### ZeroDev Kernel v3 module provisioning on 4663 (checked at M1, 2026-09-10)
Stack is ZeroDev Kernel v3 + EntryPoint v0.7 (ADR 0004). The session-key enforcement was proven on an
anvil fork of 4663 by calling `EntryPoint.handleOps` directly (no bundler, no real ETH): an in-scope
capped op executes and the account pays its own gas; over-cap, disallowed-token, and wrong-recipient
ops are rejected at validation with distinct policy revert selectors.
- PRESENT on 4663: the call-policy module, the timestamp-policy module, and the ECDSA signer module.
- **MISSING on 4663: the rate-limit policy singleton `0xf63d4139B25c836334edD76641356c6b74C86873`
  (no code).** Our validator installs it on enable, so a session key CANNOT be enabled on 4663 until
  it is deployed. It is a stateless CREATE2-deterministic singleton, byte-identical on Base/Arbitrum
  (runtime sha1 `76df344c…`). **Required pre-M1-ship on-chain step: deploy this module on 4663 from a
  funded key, then re-verify all four permission modules have code.** The fork test injects the
  runtime via `anvil_setCode` to represent a provisioned 4663.

## Uniswap (v3 used for stock trading; v4 is PONS's own pool)
- v3 factory: `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`. SwapRouter02: `0xCaf681a66D020601342297493863E78C959E5cb2`.
  QuoterV2: `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`. NPM: `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`.
- SwapRouter02 `exactInputSingle` selector `0x04e45aaf`; params tuple has NO deadline field:
  (tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96).
- v4 PoolManager: `0x8366a39cc670b4001a1121b8f6a443a643e40951`.

## Core tokens
- USDG (6 dec): `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (balances at storage slot 1). ~$1.00.
- WETH (18 dec): `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.
- cbBTC (8 dec): `0xcec185eb182c47d1ba1efc84e6959e18cd620be4`.

## Tradeable asset universe (the ~17: deep pool AND Chainlink feed)
194 assets exist. The Chainlink directory holds 57 feeds total, of which ~35 map to tradeable assets
(the rest are ETH/cbBTC/USDG/FX). ~17 assets have real pool depth. Trade only assets with BOTH depth
AND a fresh feed. Quote in USDG by default; use WETH for SPY. Stock tokens are 18-dec ERC-20s. Depth
= USDG the best pool holds (~USD). Two rows below are exceptions to the "AND feed" rule: GLD has NO
Chainlink feed (price it off the GLD/USDG TWAP, and do NOT trade it off-hours), and NFLX's feed
address must be read from the directory at build. Everything else in the table has a listed feed.

| Asset | Token (18dec) | Best pool | Fee | USDG depth | Chainlink feed (8dec) |
|---|---|---|---|---:|---|
| NVDA | 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC | 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 | 500 | $3.56M | 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 |
| GLD | 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e | 0x7A6A053eCCf1446A2633E05aA6D40D09381997ec | 3000 | $2.08M | UNKNOWN (no feed found; use USDG-pool TWAP) |
| SGOV | 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5 | 0xfAb520051f96F4D2a32c22B6a3dD7fFfdf231bFe | 3000 | $2.19M | 0xa0DF4ee0fFf975306345875E3548Fcc519577A11 |
| GME | 0x1b0E319c6A659F002271B69dB8A7df2F911c153E | 0xE9713f453aDB9245B19559790c96F470a18F2fDF | 10000 | $1.02M | 0x27C71df6A64fB476468EdF256CF72c038baB5B67 |
| TSLA | 0x322F0929c4625eD5bAd873c95208D54E1c003b2d | 0xf4ACdAEEB7022862A763C9B1B885e11191c889E3 | 3000 | $845k | 0x4A1166a659A55625345e9515b32adECea5547C38 |
| USO | 0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344 | 0x02175608F1b5E6b5ed221cCFdC7Be197D111D915 | 3000 | $699k | 0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c |
| AMZN | 0x12f190a9F9d7D37a250758b26824B97CE941bF54 | 0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef | 3000 | $559k | 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C |
| MSTR | 0xec262a75e413fAfD0dF80480274532C79D42da09 | 0x17578C0e0D15da44f31677263114F71aE76653EA | 10000 | $424k | 0x396118bdFB181e6240E74D243F266B061c0edc3D |
| MSFT | 0xe93237C50D904957Cf27E7B1133b510C669c2e74 | 0xeb60bCD1D920ad6E102690CCFC6fB488899E1510 | 3000 | $410k | 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E |
| QQQ | 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68 | 0xD60A5d14dB690B7Afad71F76B108071D7175597d | 500 | $338k | 0x80901d846d5D7B030F26B480776EE3b29374C2ae |
| AAPL | 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9 | 0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D | 500 | $223k | 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0 |
| META | 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35 | 0x107a7Cb40d8665360ba10E59471Af06150A50922 | 3000 | $201k | 0x7C38C00C30BEe9378381E7B6135d7283356D71b1 |
| GOOGL | 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3 | 0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7 | 500 | $189k | 0xF6f373a037c30F0e5010d854385cA89185AE638b |
| SLV | 0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f | 0x8cB787e6c315D464775289BaD00FDD67d53Ecb3D | 3000 | $128k | 0x209b73908e92Ae021826eD79609845451Ecba2ce |
| AMD | 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC | 0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f | 3000 | $95k | 0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72 |
| NFLX | 0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8 | 0x59895C0302F41aEaa129D2fa2442CEc01E7eF45E | 3000 | $82k | NONE (verified absent from the live directory 2026-09-10) |
| SPY | 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C | USDG:0xa7Bb1AC63BBaB0C44316E6c8C455213441689167 (500, $55k); WETH:0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e (500, ~$807k) | - | 0x319724394D3A0e3669269846abE664Cd621f9f6A |

- COIN token `0x6330D8C3178a418788dF01a47479c0ce7CCF450b`: USDG pool exists but is DEAD (zero liquidity). Untradeable.
- Other feeds: ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, cbBTC/USD `0x0009cD492adf8167f9eEBf1293556A673530a21a`, USDG/USD `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`.
- USDG EIP-712 domain (checked at M2, 2026-09-10, for x402 EIP-3009): `name()` = `"Global Dollar"`
  (NOT "USDG"); `version()` REVERTS (recover the version by matching the on-chain `DOMAIN_SEPARATOR()`);
  `authorizationState` responds, so EIP-3009 `transferWithAuthorization` is likely present (confirm the
  full selector before real settlement). The x402 self facilitator must sign against this real domain.
- Full Chainlink directory: `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json` (57 feeds).
- Full asset list: `GET https://api.robinhood.com/rhj/assets` (no auth, 194 assets).

## Market hours and pricing
- No on-chain market-hours or transfer gate. Tokens trade 24/7 permissionlessly.
- Equity Chainlink feeds run 24/5 and go STALE off-hours (no heartbeat; hold last price). Confirmed:
  NVDA feed was 15.7h stale over a weekend. GATE every decision on `block.timestamp - updatedAt`.
- Decision price: Chainlink feed (freshness-gated). Execution sanity: v3 pool TWAP (`observe`,
  cardinality expanded on deep pools: NVDA/USDG-500 = 6000). TWAP is manipulable off-hours; do not
  trust it as truth off-hours.
- Safest to trade off-hours: SGOV (short treasuries) and SLV (has a feed). GLD is NOT off-hours-safe:
  it has no feed and only a thin TWAP. Equities: trade only when the feed is fresh (market hours).
- Staleness cutoffs (see SPEC.md section 6): equities 300s; SGOV/SLV 24h; GLD off-hours = no trade.

## Phase 0 proofs (all green, watched by the model)
- `test/Phase0.fork.t.sol`: launched a native-ETH token with `creatorFeeRecipient` = an agent wallet;
  8 x 0.05 ETH buys accrued 0.004 ETH (1%); sweepFees credited 0.0028 ETH (70%) to the agent in the
  escrow (launcher got 0); `escrow.claim()` landed the ETH. Self-funding loop proven.
- `test/Phase0Stock.fork.t.sol`: an AgentWallet swapped 2260 USDG -> 10.07 NVDA on the live v3 pool,
  held it, round-tripped back with ~0.1% loss. Stock trading proven.
- `agent/agent.mjs`: a zero-dep OpenRouter (claude-sonnet-5) tool-calling loop read the live treasury
  on 4663 and served an x402 pay-gate. The 2026 agent loop proven (lite).
- Toolchain: foundry 0.2.0, solc 0.8.30, evm cancun, via_ir=false. forge-std symlinked from
  `~/dev/september/rebound/lib`. Node v22. Reuse the $REBOUND fork-test harness for PONS launches.
