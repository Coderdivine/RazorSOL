const axios = require('axios');
const bs58 = require('bs58').default || require('bs58');
const { VersionedTransaction, Keypair, PublicKey } = require('@solana/web3.js');
const solanaService = require('./solana.service');
const WatchedWallet = require('../models/WatchedWallet');
const TokenMetrics = require('../models/TokenMetrics');
const ActiveTrade = require('../models/ActiveTrade');
const WhalePosition = require('../models/WhalePosition');
const { loadTradingConfig } = require('../config/trading');
const {
    computeTradeSize, parseOwnFill, describeTxError, paperFill, parseSellFraction,
    curveBuyTokens, curveSellSol, OPEN_STATUSES, BASE_FEE_SOL, TOKEN_ACCOUNT_RENT_SOL
} = require('../utils/trade-math');

const { WALLET_PUBLIC_KEY, WALLET_PRIVATE_KEY } = process.env;

function formatMarketCap(mcUSD) {
    if (!mcUSD || mcUSD <= 0) return 'Live on DEX';
    if (mcUSD >= 1_000_000_000) {
        return `$${(mcUSD / 1_000_000_000).toFixed(2)}B`;
    }
    if (mcUSD >= 1_000_000) {
        return `$${(mcUSD / 1_000_000).toFixed(2)}M`;
    }
    if (mcUSD >= 1_000) {
        return `$${(mcUSD / 1_000).toFixed(1)}k`;
    }
    return `$${Math.round(mcUSD).toLocaleString('en-US')}`;
}

function getTokenLinks(mint) {
    const isPump = Boolean(mint && mint.endsWith('pump'));
    return {
        isPump,
        tokenUrl: isPump ? `https://pump.fun/${mint}` : `https://dexscreener.com/solana/${mint}`,
        dexUrl: `https://dexscreener.com/solana/${mint}`,
        pumpUrl: `https://pump.fun/${mint}`,
        solscanUrl: `https://solscan.io/token/${mint}`,
        gmgnUrl: `https://gmgn.ai/sol/token/${mint}`,
        footerButtons: `📊 [DexScreener](https://dexscreener.com/solana/${mint}) | 💊 [Pump.fun](https://pump.fun/${mint}) | 🔎 [Solscan](https://solscan.io/token/${mint}) | ⚡ [GMGN](https://gmgn.ai/sol/token/${mint})`
    };
}

class TradeEngine {
    constructor() {
        this.cfg = loadTradingConfig();
        // Share the single RPC connection (and its one websocket) with the Solana service.
        this.connection = solanaService.connection;
        console.log(`[TRADE-ENGINE] ${this.cfg.isPaper ? '📝 PAPER MODE: fills are simulated, no funds move. Set TRADING_MODE=live to trade real funds.' : '🔴 LIVE MODE: real funds are traded.'}`);
        console.log(`[TRADE-ENGINE] ⚙️ Sizing: ${(this.cfg.tradeFraction * 100).toFixed(0)}% of balance per trade, min ${this.cfg.minTradeSol} SOL, reserve ${this.cfg.reserveSol} SOL. Slippage: buy ${this.cfg.buySlippagePct}%, sell ${this.cfg.sellSlippagePct}%.`);
        // Base keys
        this.myWalletKey = WALLET_PUBLIC_KEY;
        this.myKeypair = null;
        if(WALLET_PRIVATE_KEY) {
            try {
                this.myKeypair = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
                console.log("[TRADE-ENGINE] ✅ Wallet Private Key loaded successfully.");
            } catch(e) {
                console.error("[TRADE-ENGINE] ❌ Failed to decode private key", e.message);
            }
        } else {
             console.log("[TRADE-ENGINE] ⚠️ No Wallet Private Key found in .env");
        }
        
        // Caching
        this.myBalance = 0;
        this.myBalanceUpdatedAt = 0;
        this.lastMcSol = new Map();          // mint -> { mc, t } freshest market cap seen (SOL)
        this.lastTokenBalCheck = new Map();  // tradeId -> last on chain token balance check
        this.tokenCache = new Map(); // In-memory cache to prevent MongoDB flooding
        
        // Clear memory cache every 1 hour to prevent memory leaks from 1000s of tokens
        setInterval(() => {
            console.log(`[TRADE-ENGINE] 🧹 Clearing in-memory token cache (${this.tokenCache.size} tokens removed).`);
            this.tokenCache.clear();
            const cutoff = Date.now() - 3600000;
            for (const [k, v] of this.lastMcSol) if (v.t < cutoff) this.lastMcSol.delete(k);
        }, 3600000);
        
        // Settings & Thresholds
        this.earlyCADiscoveryEnabled = false; // Disabled by default per user request
        this.watchlistThresholdUSD = 10000; // Increased to $10,000 USD per user request
        this.MILESTONES = [10000, 20000, 30000, 40000, 50000, 60000, 70000];
        this.STOP_LOSS_PERCENT = 54; // -54% drop from entry triggers 100% sell off
        this.TAKE_PROFIT_FACTOR = 2.0; // 2x gain triggers 75% profit take, 25% moonbag held

        // Continuous Active Trade TP/SL Monitor (Runs every 10 seconds)
        // Ensures 2x (+100%) TP (sell 75%, hold 25%) and -54% SL (sell off 100%) are evaluated
        setInterval(async () => {
            try {
                await this.pollActiveTradesForTPSL();
            } catch (err) {
                // Non-blocking
            }
        }, 10000);

        // Real-Time Wallet Deposit Listener (Instant sub-second detection on funding)
        this.lastNotifiedBalance = 0;
        this.isDepositListenerReady = false;
        this.isHandlingDeposit = false;
        this.lastDepositAlertTime = 0;
        this.startWalletDepositListener();
    }

    async startWalletDepositListener() {
        if (!this.myWalletKey) return;
        try {
            const pubkey = new PublicKey(this.myWalletKey);

            // Pre-seed current on-chain balance immediately so server boots/restarts NEVER trigger a fake duplicate alert
            try {
                const currentBal = await solanaService.getSolBalance(this.myWalletKey);
                if (currentBal === null) throw new Error('balance unavailable');
                this.myBalance = currentBal;
                this.myBalanceUpdatedAt = Date.now();
                this.lastNotifiedBalance = currentBal;
                this.isDepositListenerReady = true;
                console.log(`[TRADE-ENGINE] 👁️ Real-time wallet funding listener attached to ${this.myWalletKey} (Starting Balance: ${currentBal.toFixed(4)} SOL)`);
            } catch (initErr) {
                this.isDepositListenerReady = true;
            }

            // 1. WebSocket onAccountChange listener for instant sub-second detection
            this.connection.onAccountChange(pubkey, async (accountInfo) => {
                const newBalance = accountInfo.lamports / 1e9;
                await this.handleBalanceUpdate(newBalance, 'Instant RPC WebSocket');
            }, 'confirmed');

            // 2. Slow safety poll. The websocket above does the real work, so this stays cheap on RPC credits.
            setInterval(async () => {
                try {
                    const bal = await solanaService.getSolBalance(this.myWalletKey);
                    if (bal !== null) await this.handleBalanceUpdate(bal, 'Periodic Poller');
                } catch (e) {
                    // Non-blocking
                }
            }, this.cfg.balancePollMs);
        } catch (err) {
            console.error(`[TRADE-ENGINE] ❌ Error attaching wallet deposit listener:`, err.message);
        }
    }

    async handleBalanceUpdate(newBalance, source = 'RPC') {
        // A failed read is "unknown", never a zero balance (that used to trigger fake deposit alerts).
        if (newBalance === null || newBalance === undefined || !Number.isFinite(newBalance)) return;
        this.myBalanceUpdatedAt = Date.now();
        if (!this.isDepositListenerReady) return;
        if (this.isHandlingDeposit) return;

        const prev = this.myBalance || 0;
        const lastNotified = this.lastNotifiedBalance || 0;

        // If balance has not increased by more than 0.001 SOL, simply update tracker
        if (newBalance <= lastNotified + 0.001 || newBalance <= prev) {
            this.myBalance = newBalance;
            if (newBalance > lastNotified) this.lastNotifiedBalance = newBalance;
            return;
        }

        // Debounce: prevent duplicate notification within 30 seconds
        const now = Date.now();
        if (now - this.lastDepositAlertTime < 30000) {
            this.myBalance = newBalance;
            this.lastNotifiedBalance = newBalance;
            return;
        }

        // Lock mutex to prevent concurrent execution from WebSocket + Poller
        this.isHandlingDeposit = true;
        this.lastDepositAlertTime = now;
        const deposited = newBalance - lastNotified;
        this.lastNotifiedBalance = newBalance;
        this.myBalance = newBalance;

        const solPrice = solanaService.getSolPriceUSD();
        const usdVal = (newBalance * solPrice).toFixed(2);
        const depUsd = (deposited * solPrice).toFixed(2);

        console.log(`[TRADE-ENGINE] 🎉 DEPOSIT DETECTED via ${source}! Deposited: +${deposited.toFixed(4)} SOL (~$${depUsd}) | Total: ${newBalance.toFixed(4)} SOL (~$${usdVal})`);

        try {
            const telegramService = require('./telegram.service');
            const depositAlert =
`💳 *WALLET FUNDING CONFIRMED!* 💳\n\n` +
`🎉 Funds confirmed on Solana blockchain!\n` +
`💰 *Deposit Detected:* \`+${deposited.toFixed(4)} SOL\` (~$${depUsd} USD)\n` +
`💵 *Total Liquid Balance:* \`${newBalance.toFixed(4)} SOL\` (~$${usdVal} USD)\n` +
`⚡ *Status:* ${this.cfg.isPaper ? '📝 Paper mode (deposit will not be traded until TRADING_MODE=live)' : '🟢 Armed & Ready for Trade'}\n` +
`🎯 *Sizing:* ${(this.cfg.tradeFraction * 100).toFixed(0)}% of balance per trade, one position at a time`;

            // STRICTLY send to Admin's private bot chat ONLY (never to channels or groups)
            await telegramService.sendAdminDirectMessage(depositAlert);
        } catch (tErr) {
            console.warn("[TRADE-ENGINE] ⚠️ Error sending deposit alert:", tErr.message);
        } finally {
            this.isHandlingDeposit = false;
        }
    }

    async loadSettings() {
        try {
            const BotSettings = require('../models/BotSettings');
            let settings = await BotSettings.findOne({ key: "global" });
            if (!settings) {
                settings = await BotSettings.create({
                    key: "global",
                    earlyCADiscoveryEnabled: false,
                    watchlistThresholdUSD: 10000
                });
            }
            this.earlyCADiscoveryEnabled = settings.earlyCADiscoveryEnabled;
            this.watchlistThresholdUSD = settings.watchlistThresholdUSD || 10000;
            console.log(`[TRADE-ENGINE] ⚙️ Loaded Settings: Early CA Discovery=${this.earlyCADiscoveryEnabled ? 'ENABLED' : 'DISABLED'} | Threshold=$${this.watchlistThresholdUSD} USD`);
        } catch (e) {
            console.warn("[TRADE-ENGINE] ⚠️ Could not load settings from DB:", e.message);
        }
    }

    async setEarlyCADiscovery(enabled) {
        this.earlyCADiscoveryEnabled = Boolean(enabled);
        const wsService = require('./pumpportal.service');
        if (this.earlyCADiscoveryEnabled) {
            wsService.enableEarlyCADiscovery();
        } else {
            wsService.disableEarlyCADiscovery();
        }
        try {
            const BotSettings = require('../models/BotSettings');
            await BotSettings.findOneAndUpdate(
                { key: "global" },
                { earlyCADiscoveryEnabled: this.earlyCADiscoveryEnabled },
                { upsert: true, new: true }
            );
        } catch (e) {
            console.warn("[TRADE-ENGINE] ⚠️ Error saving earlyCADiscovery to DB:", e.message);
        }
        return this.earlyCADiscoveryEnabled;
    }

    async setWatchlistThreshold(amountUSD) {
        const val = Number(amountUSD);
        if (isNaN(val) || val < 1000) {
            throw new Error("Threshold must be a valid number of at least $1,000 USD.");
        }
        this.watchlistThresholdUSD = val;
        try {
            const BotSettings = require('../models/BotSettings');
            await BotSettings.findOneAndUpdate(
                { key: "global" },
                { watchlistThresholdUSD: this.watchlistThresholdUSD },
                { upsert: true, new: true }
            );
        } catch (e) {
            console.warn("[TRADE-ENGINE] ⚠️ Error saving watchlistThreshold to DB:", e.message);
        }
        return this.watchlistThresholdUSD;
    }

    /**
     * Refresh the wallet balance. Pass maxAgeMs to reuse a recent value (the websocket
     * keeps it current) instead of spending an RPC call. A failed read keeps the last
     * known balance rather than pretending the wallet is empty.
     */
    async updateMyBalance(maxAgeMs = 0) {
        if (!this.myWalletKey) return;
        if (maxAgeMs > 0 && this.myBalanceUpdatedAt && (Date.now() - this.myBalanceUpdatedAt) < maxAgeMs) return;
        const bal = await solanaService.getSolBalance(this.myWalletKey);
        if (bal === null) {
            console.warn(`[TRADE-ENGINE] ⚠️ Balance read failed. Keeping last known balance: ${this.myBalance} SOL`);
            return;
        }
        this.myBalance = bal;
        this.myBalanceUpdatedAt = Date.now();
    }

    async handleNewToken(msg) {
        if (!this.earlyCADiscoveryEnabled) return;

        const mint = msg.mint;
        const initialMC = msg.marketCapSol || 0; 
        const mcUSD = initialMC * solanaService.getSolPriceUSD();
        
        console.log(`[TRADE-ENGINE] 🆕 Registering new token in memory cache: ${mint} at MC: $${mcUSD.toFixed(2)}`);
        
        // Save to fast in-memory map instead of DB to prevent MongoDB write limit issues
        this.tokenCache.set(mint, {
            mint,
            symbol: msg.symbol || 'UNK',
            name: msg.name || 'Unknown',
            initialMC,
            highestMCReached: initialMC,
            milestonesHit: [],
            isRugged: false,
            isSavedToDB: false
        });

        // If the token already launched at >= watchlistThresholdUSD MC, evaluate & save immediately
        if (mcUSD >= this.watchlistThresholdUSD) {
            await this.updateTokenMilestones(mint, initialMC);
        }

        // Instruct WebSocket to watch this token so we get MC updates
        const wsService = require('./pumpportal.service');
        wsService.watchToken(mint);
    }

    async handleTradeEvent(msg) {
        const trader = msg.traderPublicKey;
        const mint = msg.mint;
        const mc = msg.marketCapSol; 
        const solAmount = msg.solAmount; 
        
        // 1. Update Token MC and check for milestones
        if(mint && mc) {
            this.lastMcSol.set(mint, { mc, t: Date.now() });
            await this.updateTokenMilestones(mint, mc);
        }
        
        // 2. Evaluate if it's a watched wallet trade (Copy Trade)
        if(trader) {
            const watched = await WatchedWallet.findOne({ walletAddress: trader, isActive: true });
            if(watched) {
                if (msg.txType === 'buy') {
                    console.log(`[TRADE-ENGINE] 🎯 Watched wallet ${trader} bought ${mint}`);
                    await this.executeCopyTrade(msg, watched);
                } else if (msg.txType === 'sell') {
                    console.log(`[TRADE-ENGINE] 📉 Watched wallet ${trader} sold ${mint} (+${(solAmount || 0).toFixed(4)} SOL)`);
                    await this.reportWhaleSell(msg, watched);
                }
            }
        }
        
        // 3. Evaluate if we have an active position (TP/SL)
        if(mint && mc) {
            if (!this.lastEvalByMint) this.lastEvalByMint = new Map();
            const now = Date.now();
            const lastTime = this.lastEvalByMint.get(mint) || 0;
            if (now - lastTime >= 2000) { // Throttle evaluations to once every 2 seconds per mint to prevent micro-tick storms
                this.lastEvalByMint.set(mint, now);
                await this.evaluateActiveTrades(mint, mc);
            }
        }
    }

    async checkTokenSecurity(mint) {
        if (!mint || typeof mint !== 'string') {
            return { isSafe: true };
        }
        // Pump.fun tokens natively have mint & freeze authorities revoked by contract
        if (mint.endsWith('pump')) {
            return { isSafe: true, freezeAuthority: null, mintAuthority: null };
        }
        try {
            const pubkey = new PublicKey(mint);
            const acc = await solanaService.withFallback(conn => conn.getParsedAccountInfo(pubkey));
            const info = acc?.value?.data?.parsed?.info;
            if (!info) {
                return { isSafe: true, freezeAuthority: null, mintAuthority: null };
            }

            // Freeze Authority Guard: If active, dev can freeze buyer token accounts!
            if (info.freezeAuthority) {
                return {
                    isSafe: false,
                    reason: `Active freezeAuthority (${info.freezeAuthority}) — Creator can freeze selling!`,
                    freezeAuthority: info.freezeAuthority,
                    mintAuthority: info.mintAuthority
                };
            }

            return { isSafe: true, freezeAuthority: null, mintAuthority: info.mintAuthority };
        } catch (err) {
            console.warn(`[TRADE-ENGINE] ⚠️ Security check notice for ${mint}:`, err.message);
            return { isSafe: true };
        }
    }

    async resolveTokenMetadata(mint, fallbackMcSol = 0) {
        if (!mint || typeof mint !== 'string') {
            return { name: 'Solana Token', symbol: 'SOL', marketCapUSD: 0 };
        }

        const isInvalid = (name, symbol) => {
            if (!name || !symbol) return true;
            const n = String(name).trim().toLowerCase();
            const s = String(symbol).trim().toLowerCase();
            return n === 'unknown' || n === 'unknown token' || s === 'unk' || n === 'solana token';
        };

        // 1. Check in-memory cache for Name & Symbol
        let resolvedName = null;
        let resolvedSymbol = null;
        const cached = this.tokenCache.get(mint);
        if (cached && !isInvalid(cached.name, cached.symbol)) {
            resolvedName = cached.name;
            resolvedSymbol = cached.symbol;
        }

        // 2. Check MongoDB TokenMetrics for Name & Symbol if not in memory
        if (isInvalid(resolvedName, resolvedSymbol)) {
            try {
                const dbToken = await TokenMetrics.findOne({ mint });
                if (dbToken && !isInvalid(dbToken.name, dbToken.symbol)) {
                    resolvedName = dbToken.name;
                    resolvedSymbol = dbToken.symbol;
                }
            } catch (dbErr) {
                // Non-blocking DB read error
            }
        }

        // 3. Live Market Cap Resolution
        // Always resolve live Market Cap from DexScreener / on-chain so alerts reflect real-time valuation, not stale entry
        let liveMC = 0;
        const now = Date.now();

        // Use short 15-second cache for live MC to avoid hammering APIs on rapid sequential trades
        if (cached && cached.liveMC_USD && (now - (cached.mcUpdatedAt || 0)) < 15000) {
            liveMC = cached.liveMC_USD;
        } else {
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 3500 });
                if (res.data?.pairs?.length > 0) {
                    const sortedPairs = [...res.data.pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
                    for (const p of sortedPairs) {
                        if (p.baseToken && p.baseToken.address === mint) {
                            if (isInvalid(resolvedName, resolvedSymbol)) {
                                resolvedName = p.baseToken.name;
                                resolvedSymbol = p.baseToken.symbol;
                            }
                            const candidateMC = p.marketCap || p.fdv || 0;
                            if (candidateMC > 0) {
                                liveMC = candidateMC;
                                break;
                            }
                        } else if (p.quoteToken && p.quoteToken.address === mint) {
                            if (isInvalid(resolvedName, resolvedSymbol)) {
                                resolvedName = p.quoteToken.name;
                                resolvedSymbol = p.quoteToken.symbol;
                            }
                            const candidateMC = p.marketCap || p.fdv || 0;
                            if (candidateMC > 0) {
                                liveMC = candidateMC;
                                break;
                            }
                        }
                    }
                    if (liveMC === 0 && sortedPairs[0]) {
                        const p0 = sortedPairs[0];
                        if (isInvalid(resolvedName, resolvedSymbol) && p0.baseToken) {
                            resolvedName = p0.baseToken.name;
                            resolvedSymbol = p0.baseToken.symbol;
                        }
                        liveMC = p0.marketCap || p0.fdv || 0;
                    }
                }
            } catch (dexErr) {
                // DexScreener timeout or error
            }
        }

        // 4. Fallback for Market Cap if DexScreener did not return a value
        const solPrice = solanaService.getSolPriceUSD();
        if (liveMC <= 0) {
            if (fallbackMcSol && fallbackMcSol > 0) {
                liveMC = fallbackMcSol * solPrice;
            } else if (cached && cached.highestMCReached) {
                liveMC = cached.highestMCReached * solPrice;
            }
        }

        // 5. On-chain Solana RPC (Token-2022 Extensions & Metaplex PDA) if name/symbol still needed
        if (isInvalid(resolvedName, resolvedSymbol)) {
            try {
                const onChain = await solanaService.fetchOnChainMetadata(mint);
                if (onChain && onChain.name && !isInvalid(onChain.name, onChain.symbol)) {
                    resolvedName = onChain.name;
                    resolvedSymbol = onChain.symbol || 'SOL';
                }
            } catch (rpcErr) {
                console.warn(`[TRADE-ENGINE] ⚠️ On-chain metadata lookup error for ${mint}:`, rpcErr.message);
            }
        }

        const finalName = (resolvedName && !isInvalid(resolvedName, 'OK')) ? resolvedName.trim() : 'Solana Token';
        const finalSymbol = (resolvedSymbol && resolvedSymbol !== 'UNK') ? resolvedSymbol.trim() : 'SOL';

        const tokenObj = {
            mint,
            name: finalName,
            symbol: finalSymbol,
            marketCapUSD: liveMC || 0,
            liveMC_USD: liveMC || 0,
            mcUpdatedAt: now
        };

        // Cache in memory
        this.tokenCache.set(mint, {
            ...(this.tokenCache.get(mint) || {}),
            ...tokenObj
        });

        // Upsert valid token in MongoDB
        if (!isInvalid(finalName, finalSymbol)) {
            try {
                const currentMCSol = (liveMC > 0 && solPrice > 0) ? (liveMC / solPrice) : 0;
                await TokenMetrics.findOneAndUpdate(
                    { mint },
                    {
                        $set: {
                            mint,
                            name: finalName,
                            symbol: finalSymbol
                        },
                        $max: {
                            highestMCReached: currentMCSol
                        }
                    },
                    { upsert: true, new: true }
                );
            } catch (saveErr) {}
        }

        return tokenObj;
    }

    async fetchTokenMetadataFallback(mint) {
        return await this.resolveTokenMetadata(mint);
    }

    async reportWhaleSell(tradeEvent, watchedWallet) {
        if (tradeEvent.signature) {
            if (!this.processedTradeSigs) this.processedTradeSigs = new Set();
            if (this.processedTradeSigs.has(tradeEvent.signature)) return;
            this.processedTradeSigs.add(tradeEvent.signature);
            if (this.processedTradeSigs.size > 2000) {
                const first = this.processedTradeSigs.values().next().value;
                this.processedTradeSigs.delete(first);
            }
        }

        const tokenData = await this.resolveTokenMetadata(tradeEvent.mint, tradeEvent.marketCapSol);
        const tokenName = tokenData ? `${tokenData.name} (${tokenData.symbol})` : 'Solana Token';
        let mcUSD = tokenData.marketCapUSD || (tradeEvent.marketCapSol ? tradeEvent.marketCapSol * solanaService.getSolPriceUSD() : 0);
        if (mcUSD <= 0 && tradeEvent.mint.endsWith('pump')) {
            mcUSD = 30000;
        }
        const mcTracker = formatMarketCap(mcUSD);
        const links = getTokenLinks(tradeEvent.mint);
        const shortWallet = `${watchedWallet.walletAddress.substring(0, 4)}...${watchedWallet.walletAddress.substring(watchedWallet.walletAddress.length - 4)}`;
        const whaleLabel = (watchedWallet.label && watchedWallet.label !== 'Whale Wallet') ? ` *(${watchedWallet.label})*` : '';
        const receivedSol = tradeEvent.solAmount || 0;
        const solPrice = solanaService.getSolPriceUSD();
        const receivedUsd = tradeEvent.usdAmount && tradeEvent.usdAmount > 1 ? tradeEvent.usdAmount : (receivedSol * solPrice);

        // Noise Filter for Sells: If Razor bot holds an active position, ALWAYS process to mirror 100% sell-off.
        // If Razor holds NO active position, filter out noise (avoid MC > $1M and dust sells < $100 USD).
        const activeTradesCheck = await ActiveTrade.find({
            mint: tradeEvent.mint,
            status: { $in: ["OPEN", "PARTIAL_TP_1_4X", "PARTIAL_TP_2X", "REENTERED"] }
        });
        const holdsActiveTrade = activeTradesCheck && activeTradesCheck.length > 0;

        if (!holdsActiveTrade) {
            if (mcUSD > 1_000_000 || receivedUsd < 100) {
                console.log(`[TRADE-ENGINE] 🔇 Noise Filter: Skipping whale sell alert for ${tradeEvent.mint} (No active position, received $${receivedUsd.toFixed(2)} / MC $${mcTracker}).`);
                return;
            }
        }

        const receivedDesc = receivedUsd > 1
            ? `${receivedSol.toFixed(4)} SOL (~$${receivedUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} USD)`
            : `${receivedSol.toFixed(4)} SOL`;

        // 1. Fetch tracked whale entry position for Realized Profit/Loss (Gain) calculation
        let pnlSection = '';
        let whalePos = null;
        try {
            // First search for open position
            whalePos = await WhalePosition.findOne({
                walletAddress: watchedWallet.walletAddress,
                mint: tradeEvent.mint,
                isOpen: true
            }).sort({ createdAt: -1 });

            // If not found as open, check most recently updated position
            if (!whalePos) {
                whalePos = await WhalePosition.findOne({
                    walletAddress: watchedWallet.walletAddress,
                    mint: tradeEvent.mint
                }).sort({ createdAt: -1 });
            }
        } catch (findErr) {
            console.warn("[TRADE-ENGINE] ⚠️ Error querying WhalePosition:", findErr.message);
        }

        // Declared out here because the mirror logic further down reads it too.
        let sellRatio = 1.0;
        if (whalePos && whalePos.totalSolInvested > 0) {
            const enteredTotalSol = whalePos.totalSolInvested;
            const enteredTotalTokens = whalePos.totalTokensBought || 0;
            const tokensSoldNow = tradeEvent.tokenAmount || 0;

            // Determine proportion of position sold in this exit transaction
            if (enteredTotalTokens > 0 && tokensSoldNow > 0) {
                sellRatio = Math.min(1.0, tokensSoldNow / enteredTotalTokens);
            }

            // Cost basis for the tokens sold in this exit
            const costBasisSol = enteredTotalSol * sellRatio;
            const costBasisUsd = (whalePos.totalUsdInvested || (enteredTotalSol * solPrice)) * sellRatio;

            // Realized Profit / Loss
            const netSolGain = receivedSol - costBasisSol;
            const netUsdGain = receivedUsd - costBasisUsd;
            const roiPercent = costBasisSol > 0 ? ((receivedSol - costBasisSol) / costBasisSol) * 100 : 0;
            const roiMultiplier = costBasisSol > 0 ? (receivedSol / costBasisSol) : 1;

            const isProfit = netSolGain >= 0;
            const signEmoji = isProfit ? '🟢' : '🔴';
            const gainSign = isProfit ? '+' : '';

            // Holding duration calculation
            const durationMs = Math.max(0, Date.now() - new Date(whalePos.firstBuyAt).getTime());
            const hours = Math.floor(durationMs / 3600000);
            const minutes = Math.floor((durationMs % 3600000) / 60000);
            const holdingTimeDesc = hours > 0 ? `${hours}h ${minutes}m` : `${Math.max(1, minutes)}m`;

            const enteredDesc = costBasisUsd > 1
                ? `${costBasisSol.toFixed(4)} SOL (~$${costBasisUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} USD)`
                : `${costBasisSol.toFixed(4)} SOL`;

            const gainSolDesc = `${gainSign}${netSolGain.toFixed(4)} SOL`;
            const gainUsdDesc = `${gainSign}$${Math.abs(netUsdGain).toLocaleString('en-US', { maximumFractionDigits: 2 })} USD`;
            const roiDesc = `${gainSign}${roiPercent.toFixed(1)}% (${roiMultiplier.toFixed(2)}x)`;

            pnlSection =
`🎯 *Whale Entry:* \`${enteredDesc}\`\n` +
`💰 *Whale Exit:* \`${receivedDesc}\`\n` +
`📊 *Actual Net PnL:* ${signEmoji} *${gainSolDesc}* (~${gainUsdDesc}) | *${roiDesc}*\n` +
`⏱️ *Holding Time:* \`${holdingTimeDesc}\``;

            // Update database position stats
            try {
                whalePos.totalTokensSold = (whalePos.totalTokensSold || 0) + tokensSoldNow;
                whalePos.totalSolRealized = (whalePos.totalSolRealized || 0) + receivedSol;
                whalePos.totalUsdRealized = (whalePos.totalUsdRealized || 0) + receivedUsd;
                whalePos.netRealizedSolGain = (whalePos.netRealizedSolGain || 0) + netSolGain;
                whalePos.netRealizedUsdGain = (whalePos.netRealizedUsdGain || 0) + netUsdGain;
                whalePos.roiPercent = costBasisSol > 0 ? ((whalePos.totalSolRealized - costBasisSol) / costBasisSol) * 100 : roiPercent;
                whalePos.lastSellAt = new Date();
                whalePos.sellCount = (whalePos.sellCount || 0) + 1;

                // Close position only if practically all tokens were sold (>90%)
                const remaining = Math.max(0, (whalePos.totalTokensBought || 0) - whalePos.totalTokensSold);
                whalePos.isOpen = (enteredTotalTokens > 0) ? (remaining / enteredTotalTokens > 0.10) : false;

                await whalePos.save();
                console.log(`[TRADE-ENGINE] 🏁 Recorded Whale Exit for ${watchedWallet.walletAddress} on ${tradeEvent.mint}: PnL=${gainSolDesc} (${roiDesc}) | Remaining open: ${whalePos.isOpen}`);
            } catch (saveErr) {
                console.warn("[TRADE-ENGINE] ⚠️ Error updating WhalePosition on sell:", saveErr.message);
            }
        } else {
            // Entry was prior to tracking start
            pnlSection =
`💰 *Whale Received:* \`${receivedDesc}\`\n` +
`🎯 *Whale Entry:* _Prior Entry (Purchased before tracker start)_`;
        }

        // 2. Whale Sell Mirroring: If Razor Bot holds an active position for this token, sell ALL (100%)!
        // User rule: "Ensure the whale sell is a meaningful exit (e.g., whale sold > 15% of their bag, or sold at least $100+) before dumping our entire position."
        let razorActionDesc = 'ℹ️ No Active Position';
        try {
            const activeTrades = await ActiveTrade.find({
                mint: tradeEvent.mint,
                status: { $in: ["OPEN", "PARTIAL_TP_1_4X", "PARTIAL_TP_2X", "REENTERED"] }
            });

            if (activeTrades && activeTrades.length > 0) {
                // Filter out dust/micro-test sells:
                // Whale must sell >= $100 USD OR >= 15% of their position for us to mirror exit.
                const isMeaningfulWhaleExit = (receivedUsd >= 100) || (whalePos && sellRatio >= 0.15);

                if (!isMeaningfulWhaleExit) {
                    console.log(`[TRADE-ENGINE] ℹ️ Whale Sell is micro-test/dust ($${receivedUsd.toFixed(2)}, ${(sellRatio * 100).toFixed(1)}% of bag). Skipping 100% position dump.`);
                    razorActionDesc = `⏸️ *Held Position* (Whale micro-test/dust: < $100 & < 15%)`;
                } else {
                    const allPaper = activeTrades.every(t => t.mode === 'paper');
                    if (!allPaper) await this.updateMyBalance(3000);
                    if (allPaper || this.myBalance >= 0.0005) {
                        console.log(`[TRADE-ENGINE] 🪞 Mirrored Whale Exit triggered for ${tradeEvent.mint}! Whale sold meaningful volume ($${receivedUsd.toFixed(0)}, ${(sellRatio * 100).toFixed(1)}%). Selling ALL (100%) remaining bag...`);
                        // Dynamic exit priority fee to front-run whale dumping if large volume
                        let exitPriorityFee = 0.0003;
                        if (receivedUsd >= 5000) {
                            exitPriorityFee = 0.0008; // High speed exit on whale dump
                        } else if (receivedUsd >= 2500) {
                            exitPriorityFee = 0.0005;
                        }
                        // Profit Guard on exit: ensure fee does not exceed available SOL buffer
                        exitPriorityFee = Number(Math.min(exitPriorityFee, Math.max(0.0001, this.myBalance - 0.0004)).toFixed(5));

                        const sellSig = await this.executeTradeLocal(tradeEvent.mint, "sell", "100%", false, exitPriorityFee, "WHALE_MIRROR", watchedWallet.walletAddress);
                        if (sellSig) {
                            for (let trade of activeTrades) {
                                trade.status = "CLOSED";
                                trade.closedAt = new Date();
                                trade.closeReason = "WHALE_MIRROR";
                                await trade.save();
                            }
                            razorActionDesc = `🔴 *Sold 100%* (Mirrored Whale Exit ➔ ${this.txRef(sellSig)})`;
                        } else {
                            razorActionDesc = `⚠️ *Sell Attempted* (Broadcast pending)`;
                        }
                    } else {
                        razorActionDesc = `⏸️ *Skipped* (Wallet Unfunded — \`0.0000 SOL\`)`;
                    }
                }
            }
        } catch (copyErr) {
            console.warn("[TRADE-ENGINE] ⚠️ Error mirroring whale exit:", copyErr.message);
        }

        const telegramService = require('./telegram.service');

        const cleanAlertMsg =
`🕵️‍♂️ *WHALE INTEL* ➔ *WHALE DUMP / SELL* 📉\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`⚠️ _Tracker Alert: Monitored Whale Sold (NOT your bot's trade)_\n\n` +
`👤 *Whale:* [\`${shortWallet}\`](https://solscan.io/account/${watchedWallet.walletAddress})${whaleLabel}\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${tradeEvent.mint}\`\n\n` +
`${pnlSection}\n\n` +
`📈 *Current MC:* ${mcTracker}\n` +
`🤖 *My Bot Status:* ${razorActionDesc}\n` +
`━━━━━━━━━━━━━━━━━━━━`;

        // Public VIP Group receives clean Alpha signal: No private whale address and no bot balance info leaked!
        const groupAlertMsg =
`📉 *WHALE DUMP / TAKE PROFIT ALERT* 📉\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`🎯 _Top Tracked Whale Exiting Position (Whale Sell)_\n\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${tradeEvent.mint}\`\n\n` +
`${pnlSection}\n\n` +
`📈 *Current MC:* ${mcTracker}\n` +
`━━━━━━━━━━━━━━━━━━━━`;

        telegramService.sendAlert(cleanAlertMsg, groupAlertMsg, tradeEvent.mint);
    }

    async updateTokenMilestones(mint, currentMC) {
        let token = this.tokenCache.get(mint);
        if(!token) {
            token = await TokenMetrics.findOne({ mint });
        }
        if(!token) return; 
        
        let updated = false;
        if(currentMC > token.highestMCReached) {
            token.highestMCReached = currentMC;
            updated = true;
        }
        
        const currentMC_USD = currentMC * solanaService.getSolPriceUSD();

        // Only save new tokens to permanent DB if early CA discovery is enabled and they hit the watchlist threshold
        if(this.earlyCADiscoveryEnabled && currentMC_USD >= this.watchlistThresholdUSD && !token.isSavedToDB) {
            console.log(`[TRADE-ENGINE] ⭐ Token ${mint} crossed $${Math.round(this.watchlistThresholdUSD / 1000)}k MC ($${currentMC_USD.toFixed(2)})! Saving to permanent DB watchlist.`);
            token.isSavedToDB = true;
            updated = true;
            try {
                // If it already exists it will throw dup error, which is fine to catch and ignore
                await TokenMetrics.create({
                    mint: token.mint,
                    symbol: token.symbol,
                    name: token.name,
                    initialMC: token.initialMC,
                    highestMCReached: currentMC,
                    milestonesHit: token.milestonesHit,
                    isRugged: false
                });
            } catch (e) {
                // Ignore duplicate keys if multiple trades fire concurrently
            }
        }
        
        // Check for new milestones only if Early CA discovery is enabled
        if(this.earlyCADiscoveryEnabled) {
            for(let ms of this.MILESTONES) {
                if(currentMC_USD >= ms && !token.milestonesHit.includes(ms)) {
                    console.log(`[TRADE-ENGINE] 🚀 Token ${mint} hit milestone: $${ms} MC!`);
                    token.milestonesHit.push(ms);
                    updated = true;
                    
                    // Trigger milestone snipe logic
                    await this.evaluateMilestoneSnipe(token, currentMC_USD);
                }
            }
        }
        
        if(updated) {
            if (token.save) {
                await token.save(); // It's a mongoose document
            } else {
                this.tokenCache.set(mint, token); // Update pure JS object in memory
            }
        }
    }
    
    async evaluateMilestoneSnipe(token, currentMC_USD) {
        if (!this.earlyCADiscoveryEnabled) return;
        if(token.milestonesHit.includes(10000) && token.milestonesHit.includes(20000)) {
            const existing = await ActiveTrade.findOne({ mint: token.mint });
            if(!existing && !token.hasSniped && !token.isSniping) {
                token.isSniping = true;
                console.log(`[TRADE-ENGINE] 🔫 Milestones $10k & $20k hit for ${token.mint}. Executing SNIPING logic to $50k!`);
                const tradeAmountSol = 0.05; // Default sniper size
                const sig = await this.executeTradeLocal(token.mint, "buy", tradeAmountSol, true, 0.002, "MILESTONE_SNIPE");
                if (sig) {
                    token.hasSniped = true;
                }
                token.isSniping = false;
            }
        }
    }

    async executeCopyTrade(tradeEvent, watchedWallet) {
        if (tradeEvent.signature) {
            if (!this.processedTradeSigs) this.processedTradeSigs = new Set();
            if (this.processedTradeSigs.has(tradeEvent.signature)) return;
            this.processedTradeSigs.add(tradeEvent.signature);
            if (this.processedTradeSigs.size > 2000) {
                const first = this.processedTradeSigs.values().next().value;
                this.processedTradeSigs.delete(first);
            }
        }

        // Parse Whale Buy Volume & USD Value
        const spentSol = tradeEvent.solAmount || 0;
        const solPrice = solanaService.getSolPriceUSD();
        if (!solPrice) {
            console.warn(`[TRADE-ENGINE] ⚠️ No live SOL price yet. Ignoring whale buy on ${tradeEvent.mint} rather than guessing its USD size.`);
            return;
        }
        const spentUSD = tradeEvent.usdAmount && tradeEvent.usdAmount > 1 
            ? tradeEvent.usdAmount 
            : (spentSol * solPrice);

        // FILTER 1: Noise Filter — Avoid "little amounts" (< $250 USD)
        // User rule: "then if you see him buying little amount and $1m avoid it. also always check the amount he is buying if it's more than $250 under $500k, buy. let's keep it simple and filter out noise."
        if (spentUSD < 250) {
            console.log(`[TRADE-ENGINE] 🔇 Noise Filter: Whale spent only $${spentUSD.toFixed(2)} (< $250 min threshold) on ${tradeEvent.mint}. Filtered out noise.`);
            return;
        }

        console.log(`[TRADE-ENGINE] 📊 Fetching Token Metrics for ${tradeEvent.mint}...`);
        const tokenData = await this.resolveTokenMetadata(tradeEvent.mint, tradeEvent.marketCapSol);
        let mcUSD = tokenData.marketCapUSD || (tradeEvent.marketCapSol ? tradeEvent.marketCapSol * solPrice : 0);
        if (mcUSD <= 0 && tradeEvent.mint.endsWith('pump')) {
            mcUSD = 30000; // Initial bonding curve range (~$4k - $69k)
        }
        const mcTracker = formatMarketCap(mcUSD);

        // FILTER 2: Hard Ceiling — Avoid Market Cap above $1M ($1,000,000 USD)
        // User rule: "Please avoid market cap above 1m as for us it's late. then if you see him buying little amount and $1m avoid it."
        if (mcUSD > 1_000_000) {
            console.log(`[TRADE-ENGINE] 🔇 Noise Filter: Token ${tradeEvent.mint} Market Cap is ${mcTracker} (> $1M ceiling). Avoided as it's too late.`);
            return;
        }

        // EVALUATE COPY BUY CRITERIA
        // Rule: "if it's more than $250 under $500k, buy."
        let canExecuteBuy = true;
        let skipReason = '';

        if (mcUSD >= 500_000) {
            canExecuteBuy = false;
            skipReason = `Market Cap (${mcTracker}) is above $500k buy zone (under $500k required)`;
            console.log(`[TRADE-ENGINE] ℹ️ Token ${tradeEvent.mint} MC is ${mcTracker} (>= $500k). Skipping copy-buy.`);
        }

        // 1. SINGLE ACTIVE POSITION GATE: Only block if we have an un-secured OPEN trade.
        // If a trade has already taken 1.4x TP (status: PARTIAL_TP_1_4X), our principal is back in SOL!
        // The 25% moonbag rides passively in the background, freeing our liquid SOL to enter the next qualified whale coin.
        if (canExecuteBuy) {
            const openTrade = await ActiveTrade.findOne({
                status: { $in: ["OPEN", "REENTERED"] },
                ...this.modeFilter()
            });
            if (openTrade) {
                canExecuteBuy = false;
                skipReason = `Active un-secured trade already open for ${openTrade.tokenName || openTrade.mint.substring(0, 6)} (Awaiting 1.4x TP or exit)`;
                console.log(`[TRADE-ENGINE] 🛑 Active un-secured trade already open (${openTrade.mint.substring(0,6)}...). Skipping new buy until it reaches 1.4x TP or exits.`);
            }
        }

        // 2. HONEYPOT & FREEZE AUTHORITY GUARD: Pre-buy security check
        if (canExecuteBuy) {
            const security = await this.checkTokenSecurity(tradeEvent.mint);
            if (!security.isSafe) {
                canExecuteBuy = false;
                skipReason = `Honeypot Guard: ${security.reason}`;
                console.log(`[TRADE-ENGINE] 🛑 HONEYPOT BLOCKED on ${tradeEvent.mint}! ${security.reason}`);
            }
        }

        // 3. PRICE FRESHNESS: never size or filter a trade on a stale SOL price.
        if (canExecuteBuy && !solanaService.isSolPriceFresh(this.cfg.solPriceMaxAgeMs)) {
            canExecuteBuy = false;
            skipReason = 'Live SOL price is stale. Buys are paused until a price source answers.';
        }

        // 4. POSITION SIZING: a fraction of the balance, with room left for the worst case fill,
        // fees, the token account deposit and a reserve that pays for the exit.
        const sizing = await this.sizeNextTrade();
        const balanceForSizing = sizing.balanceSol;
        const myTradeSize = sizing.sizeSol;
        const myTradeUsd = myTradeSize * solPrice;
        if (canExecuteBuy && myTradeSize <= 0) {
            canExecuteBuy = false;
            skipReason = sizing.reason;
        } else if (canExecuteBuy) {
            console.log(`[TRADE-ENGINE] 🎯 ${this.cfg.isPaper ? 'PAPER ' : ''}Trade size: ${myTradeSize.toFixed(4)} SOL (~$${myTradeUsd.toFixed(2)}) from a ${balanceForSizing.toFixed(4)} SOL balance.`);
        }

        const tokenName = tokenData ? `${tokenData.name} (${tokenData.symbol})` : 'Solana Token';
        const links = getTokenLinks(tradeEvent.mint);
        const shortWallet = `${watchedWallet.walletAddress.substring(0, 4)}...${watchedWallet.walletAddress.substring(watchedWallet.walletAddress.length - 4)}`;
        const whaleLabel = (watchedWallet.label && watchedWallet.label !== 'Whale Wallet') ? ` *(${watchedWallet.label})*` : '';

        const spentDesc = spentUSD > 1
            ? `${spentSol.toFixed(4)} SOL (~$${spentUSD.toLocaleString('en-US', { maximumFractionDigits: 2 })} USD)`
            : `${spentSol.toFixed(4)} SOL`;

        // Track Whale Entry Position for PnL / Gain calculation upon exit
        try {
            let whalePos = await WhalePosition.findOne({
                walletAddress: watchedWallet.walletAddress,
                mint: tradeEvent.mint,
                isOpen: true
            });

            const usdInvested = spentUSD;

            if (whalePos) {
                whalePos.totalSolInvested += spentSol;
                whalePos.totalUsdInvested += usdInvested;
                whalePos.totalTokensBought += (tradeEvent.tokenAmount || 0);
                whalePos.buyCount += 1;
                whalePos.lastBuyAt = new Date();
                await whalePos.save();
                console.log(`[TRADE-ENGINE] 📈 Updated Whale DCA Position for ${watchedWallet.walletAddress} on ${tradeEvent.mint} (Total: ${whalePos.totalSolInvested.toFixed(4)} SOL)`);
            } else {
                await WhalePosition.create({
                    walletAddress: watchedWallet.walletAddress,
                    mint: tradeEvent.mint,
                    tokenName: tokenData ? tokenData.name : 'Unknown Token',
                    tokenSymbol: tokenData ? tokenData.symbol : 'UNK',
                    totalTokensBought: tradeEvent.tokenAmount || 0,
                    totalSolInvested: spentSol,
                    totalUsdInvested: usdInvested,
                    entryMarketCapUSD: mcUSD,
                    firstBuyAt: new Date(),
                    lastBuyAt: new Date(),
                    buyCount: 1,
                    isOpen: true
                });
                console.log(`[TRADE-ENGINE] 📝 Recorded new Whale Entry Position for ${watchedWallet.walletAddress} on ${tradeEvent.mint} (${spentSol.toFixed(4)} SOL)`);
            }
        } catch (posErr) {
            console.warn("[TRADE-ENGINE] ⚠️ Error recording WhalePosition entry:", posErr.message);
        }

        const telegramService = require('./telegram.service');

        let myActionDesc = canExecuteBuy
            ? `${this.cfg.isPaper ? '📝 *Paper Buy*' : '🟢 *Copy-Buy Triggered*'} (Entering \`${myTradeSize.toFixed(4)} SOL\`)`
            : `⏸️ *Skipped* (${skipReason})`;

        const cleanAlertMsg =
`🕵️‍♂️ *WHALE INTEL* ➔ *WHALE BUY DETECTED* 🚨\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`⚠️ _Tracker Alert: Monitored Whale Bought (NOT your bot's trade)_\n\n` +
`👤 *Whale:* [\`${shortWallet}\`](https://solscan.io/account/${watchedWallet.walletAddress})${whaleLabel}\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${tradeEvent.mint}\`\n` +
`💰 *Whale Spent:* \`${spentDesc}\`\n` +
`📈 *Current MC:* ${mcTracker}\n` +
`🤖 *My Bot Action:* ${myActionDesc}\n` +
`━━━━━━━━━━━━━━━━━━━━`;

        // Public VIP Group receives clean Alpha signal: No private whale address and no bot balance info leaked!
        const groupAlertMsg =
`🚨 *WHALE BUY DETECTED* 🚨\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`🎯 _High-Conviction Whale Entry Snipe (Whale Buy)_\n\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${tradeEvent.mint}\`\n` +
`💰 *Whale Buy Size:* \`${spentDesc}\`\n` +
`📈 *Current MC:* ${mcTracker}\n` +
`━━━━━━━━━━━━━━━━━━━━`;

        telegramService.sendAlert(cleanAlertMsg, groupAlertMsg, tradeEvent.mint);

        if (canExecuteBuy) {
            // WHALE CONVICTION MULTIPLIER & PROFIT GUARD
            // Determine target priority fee based on Whale Buy volume:
            // - Standard ($250 to $2,499): 0.0001 SOL (~$0.015)
            // - Elevated ($2,500 to $4,999): 0.0003 SOL (~$0.045, 3x faster)
            // - Massive Conviction (≥ $5,000): 0.0010 SOL (~$0.15, 10x faster) to front-run the copy-bot herd
            let targetPriorityFee = 0.0001;
            let convictionTier = 'STANDARD';

            if (spentUSD >= 5000) {
                targetPriorityFee = 0.0010;
                convictionTier = 'MASSIVE_CONVICTION';
            } else if (spentUSD >= 2500) {
                targetPriorityFee = 0.0003;
                convictionTier = 'ELEVATED_CONVICTION';
            }

            // PROFIT GUARD: Protect net trading profit!
            // Ensure priority fee NEVER exceeds 1.5% of trade capital.
            // When testing with small balances ($1 - $5 / 0.01 - 0.03 SOL), gas will not eat our profit.
            // Minimum floor is 0.0001 SOL.
            const maxSafeGasFee = Math.max(0.0001, myTradeSize * 0.015);
            const priorityFee = Number(Math.min(targetPriorityFee, maxSafeGasFee).toFixed(5));

            console.log(`[TRADE-ENGINE] 🎯 QUALIFIED BUY: Whale spent $${spentUSD.toFixed(0)} (> $250) under $500k MC (${mcTracker})! Conviction: ${convictionTier} | Priority Fee: ${priorityFee} SOL (Profit Guard Active). Entering ${myTradeSize.toFixed(4)} SOL...`);
            await this.executeTradeLocal(tradeEvent.mint, "buy", myTradeSize, true, priorityFee, "COPY_TRADE", watchedWallet.walletAddress, null, false, convictionTier);
        } else {
            console.log(`[TRADE-ENGINE] ℹ️ Buy trade execution skipped: ${skipReason}`);
        }
    }

    async pollActiveTradesForTPSL() {
        try {
            const activeTrades = await ActiveTrade.find({ status: { $in: OPEN_STATUSES } });
            if (!activeTrades || activeTrades.length === 0) return;

            const solPrice = solanaService.getSolPriceUSD();
            if (!solPrice) return; // no live price, do not evaluate exits on a guess

            const hasLive = activeTrades.some(t => t.mode !== 'paper');
            if (hasLive) await this.updateMyBalance(60000);

            for (const trade of activeTrades) {
                try {
                    const isPaper = trade.mode === 'paper';
                    if (!isPaper) {
                        if (this.myBalance < 0.0005) continue; // cannot pay for an exit until funded

                        // Check the real token balance occasionally, not on every 10s tick.
                        const id = trade._id.toString();
                        const last = this.lastTokenBalCheck.get(id) || 0;
                        if (this.myWalletKey && (Date.now() - last) >= this.cfg.tokenBalancePollMs) {
                            this.lastTokenBalCheck.set(id, Date.now());
                            const tokenBal = await solanaService.getTokenBalance(this.myWalletKey, trade.mint);
                            // Only a CONFIRMED zero closes the trade. A failed read (null) never does.
                            if (tokenBal !== null && tokenBal <= 0 && (Date.now() - new Date(trade.createdAt).getTime()) > 300000) {
                                trade.status = "CLOSED";
                                trade.closeReason = "ZERO_TOKEN_BALANCE";
                                trade.closedAt = new Date();
                                trade.accountingIncomplete = true; // tokens left the wallet outside the bot
                                await trade.save();
                                this.lastTokenBalCheck.delete(id);
                                continue;
                            }
                        }
                    }

                    const meta = await this.resolveTokenMetadata(trade.mint);
                    if (meta && meta.marketCapUSD > 0) {
                        const currentMC_Sol = meta.marketCapUSD / solPrice;
                        await this.evaluateActiveTrades(trade.mint, currentMC_Sol);
                    }
                } catch (tradeErr) {
                    // Non-blocking per-trade error
                }
            }
        } catch (pollErr) {
            // Non-blocking
        }
    }

    async evaluateActiveTrades(mint, currentMC) {
        if (!mint || !currentMC || currentMC <= 0) return;

        if (!this.tradeExecutionLocks) this.tradeExecutionLocks = new Set();

        const solPrice = solanaService.getSolPriceUSD();
        const currentMC_USD = currentMC * solPrice;
        this.lastMcSol.set(mint, { mc: currentMC, t: Date.now() });

        const activeTrades = await ActiveTrade.find({
            mint,
            status: { $in: ["OPEN", "PARTIAL_TP_1_4X", "PARTIAL_TP_2X", "REENTERED"] }
        });
        
        for (let trade of activeTrades) {
            const tradeIdStr = trade._id.toString();
            // In-flight mutex: if this trade is already executing an order on-chain, skip to prevent duplicate concurrent transactions
            if (this.tradeExecutionLocks.has(tradeIdStr)) {
                continue;
            }

            // Ensure entryMarketCap is valid
            if (!trade.entryMarketCap || trade.entryMarketCap <= 0) {
                if (trade.entryMarketCapUSD && trade.entryMarketCapUSD > 0 && solPrice > 0) {
                    trade.entryMarketCap = trade.entryMarketCapUSD / solPrice;
                } else {
                    // No entry reference was recorded. Start measuring from this price instead of
                    // leaving the position with no exit rules at all.
                    trade.entryMarketCap = currentMC;
                    console.warn(`[TRADE-ENGINE] ⚠️ ${mint} had no entry reference. Exit rules now measure from ${currentMC.toFixed(2)} SOL market cap.`);
                }
                await trade.save();
            }

            const entryMC = trade.entryMarketCap; // in SOL
            const ratio = currentMC / entryMC;
            const pnlPercent = (ratio - 1.0) * 100;
            const tradeAgeMs = Date.now() - new Date(trade.createdAt).getTime();
            const tradeAgeMinutes = tradeAgeMs / 60000;

            // Track highest ratio seen
            if (ratio > (trade.highestRatioSeen || 1.0)) {
                trade.highestRatioSeen = ratio;
                await trade.save();
            }

            // RULE 1: HARD STOP LOSS AT -28% DROP FROM ENTRY -> SELL OFF 100%
            if (ratio <= 0.72 || pnlPercent <= -28) {
                console.log(`[TRADE-ENGINE] 🛑 Tight Stop Loss (-28%) Triggered on ${mint}! Entry: ${entryMC.toFixed(2)} SOL ($${(entryMC * solPrice).toFixed(0)}) | Current: ${currentMC.toFixed(2)} SOL ($${currentMC_USD.toFixed(0)}) | Drop: ${pnlPercent.toFixed(1)}%. Executing 100% SELL OFF!`);

                this.tradeExecutionLocks.add(tradeIdStr);
                try {
                    const sellSig = await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, "STOP_LOSS_28", null, trade._id);
                    if (sellSig) {
                        trade.status = "CLOSED";
                        trade.closedAt = new Date();
                        trade.closeReason = "STOP_LOSS_28";
                        await trade.save();
                    } else {
                        console.warn(`[TRADE-ENGINE] ⚠️ Stop loss sell for ${mint} unconfirmed on-chain. Trade remains active.`);
                    }
                } finally {
                    this.tradeExecutionLocks.delete(tradeIdStr);
                }
                continue;
            }

            // RULE 2: BREAKEVEN GUARD (ARM AT +20%, EXIT AT ENTRY PRICE / $0 LOSS)
            if (trade.status === "OPEN") {
                if (!trade.isBreakevenArmed && (ratio >= 1.20 || pnlPercent >= 20)) {
                    trade.isBreakevenArmed = true;
                    console.log(`[TRADE-ENGINE] 🛡️ Breakeven Guard ARMED for ${mint}! Coin reached +${pnlPercent.toFixed(1)}% (≥ +20%). Stop Loss moved to Entry Price ($0 risk).`);
                    await trade.save();
                }

                if (trade.isBreakevenArmed && ratio <= 1.00) {
                    console.log(`[TRADE-ENGINE] 🛡️ Breakeven Stop Triggered on ${mint}! Peaked at +${(((trade.highestRatioSeen || 1.2) - 1) * 100).toFixed(1)}%, now retraced to entry price (${ratio.toFixed(2)}x). Exiting 100% to guarantee $0 LOSS!`);

                    this.tradeExecutionLocks.add(tradeIdStr);
                    try {
                        const sellSig = await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, "BREAKEVEN_STOP", null, trade._id);
                        if (sellSig) {
                            trade.status = "CLOSED";
                            trade.closedAt = new Date();
                            trade.closeReason = "BREAKEVEN_STOP";
                            await trade.save();
                        } else {
                            console.warn(`[TRADE-ENGINE] ⚠️ Breakeven stop sell for ${mint} unconfirmed on-chain. Trade remains active.`);
                        }
                    } finally {
                        this.tradeExecutionLocks.delete(tradeIdStr);
                    }
                    continue;
                }
            }

            // RULE 3: 15-MINUTE STAGNATION / DEAD TRADE TIMEOUT
            if (trade.status === "OPEN" && tradeAgeMinutes >= 15 && (ratio <= 0.85 || pnlPercent <= -15)) {
                console.log(`[TRADE-ENGINE] ⏳ 15-Min Stagnation Guard Triggered on ${mint}! Open for ${tradeAgeMinutes.toFixed(1)}m | PnL: ${pnlPercent.toFixed(1)}%. Zero momentum. Cutting trade early to protect remaining ${(ratio * 100).toFixed(0)}% capital!`);

                this.tradeExecutionLocks.add(tradeIdStr);
                try {
                    const sellSig = await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, "TIMEOUT_STAGNANT_15M", null, trade._id);
                    if (sellSig) {
                        trade.status = "CLOSED";
                        trade.closedAt = new Date();
                        trade.closeReason = "TIMEOUT_STAGNANT_15M";
                        await trade.save();
                    } else {
                        console.warn(`[TRADE-ENGINE] ⚠️ Stagnation sell for ${mint} unconfirmed on-chain. Trade remains active.`);
                    }
                } finally {
                    this.tradeExecutionLocks.delete(tradeIdStr);
                }
                continue;
            }

            // RULE 4: TAKE PROFIT AT 1.4x GAIN -> SELL 75%, HOLD REMAINING 25% TO CAPTURE MOONSHOT
            if (ratio >= 5.0 && trade.status === "OPEN") {
                console.log(`[TRADE-ENGINE] 🚀 5x Moonshot Target Reached on ${mint}! Entry: ${entryMC.toFixed(2)} SOL ($${(entryMC * solPrice).toFixed(0)}) | Current: ${currentMC.toFixed(2)} SOL ($${currentMC_USD.toFixed(0)}) | Gain: +${pnlPercent.toFixed(1)}% (${ratio.toFixed(2)}x). Cashing out 100% full bag!`);

                this.tradeExecutionLocks.add(tradeIdStr);
                try {
                    const sellSig = await this.executeTradeLocal(mint, "sell", "100%", false, 0.0005, "MAX_TP_5X", null, trade._id);
                    if (sellSig) {
                        trade.status = "CLOSED";
                        trade.closedAt = new Date();
                        trade.closeReason = "MAX_TP_5X";
                        await trade.save();
                    } else {
                        console.warn(`[TRADE-ENGINE] ⚠️ 5x TP sell for ${mint} unconfirmed on-chain. Trade remains active.`);
                    }
                } finally {
                    this.tradeExecutionLocks.delete(tradeIdStr);
                }
                continue;
            }

            if (ratio >= 1.4 && trade.status === "OPEN") {
                console.log(`[TRADE-ENGINE] 💸 1.4x Take Profit Triggered on ${mint}! Entry: ${entryMC.toFixed(2)} SOL ($${(entryMC * solPrice).toFixed(0)}) | Current: ${currentMC.toFixed(2)} SOL ($${currentMC_USD.toFixed(0)}) | Gain: +${pnlPercent.toFixed(1)}% (${ratio.toFixed(2)}x). Selling 75%, retaining 25% moonbag!`);

                this.tradeExecutionLocks.add(tradeIdStr);
                try {
                    const sellSig = await this.executeTradeLocal(mint, "sell", "75%", false, 0.0001, "TAKE_PROFIT_1_4X", null, trade._id);
                    if (sellSig) {
                        trade.status = "PARTIAL_TP_1_4X";
                        trade.tp14xExecutedAt = new Date();
                        trade.highestMarketCapPostTP = currentMC;
                        await trade.save();
                    } else {
                        console.warn(`[TRADE-ENGINE] ⚠️ 1.4x TP sell for ${mint} unconfirmed on-chain. Status remains OPEN.`);
                    }
                } finally {
                    this.tradeExecutionLocks.delete(tradeIdStr);
                }
                continue;
            }

            // RULE 5: ADVANCED MOONBAG LIFECYCLE (25% HOLDING PHASE)
            if (trade.status === "PARTIAL_TP_1_4X" || trade.status === "PARTIAL_TP_2X") {
                if (!trade.highestMarketCapPostTP || trade.highestMarketCapPostTP <= 0) {
                    trade.highestMarketCapPostTP = currentMC;
                    await trade.save();
                }
                if (currentMC > trade.highestMarketCapPostTP) {
                    trade.highestMarketCapPostTP = currentMC;
                    await trade.save();
                    console.log(`[TRADE-ENGINE] 🚀 Moonbag new peak for ${mint}: ${currentMC.toFixed(2)} SOL ($${currentMC_USD.toFixed(0)} USD)`);
                }

                const dropFromPeak = (currentMC - trade.highestMarketCapPostTP) / trade.highestMarketCapPostTP;
                const tpTime = trade.tp14xExecutedAt ? new Date(trade.tp14xExecutedAt).getTime() : new Date(trade.createdAt).getTime();
                const minutesSinceTP = (Date.now() - tpTime) / 60000;

                const moonbagExitFee = Number(Math.min(0.0005, Math.max(0.0001, this.myBalance - 0.0004)).toFixed(5));

                // 5A. Max 5x Hard Take Profit Cap
                if (ratio >= 5.0 || pnlPercent >= 400) {
                    console.log(`[TRADE-ENGINE] 🚀 5x Moonbag Target Reached on ${mint}! Entry: ${entryMC.toFixed(2)} SOL ($${(entryMC * solPrice).toFixed(0)}) | Current: ${currentMC.toFixed(2)} SOL ($${currentMC_USD.toFixed(0)}) | Gain: +${pnlPercent.toFixed(1)}% (${ratio.toFixed(2)}x). Cashing out 100% of moonbag to lock in 5x win!`);

                    this.tradeExecutionLocks.add(tradeIdStr);
                    try {
                        const sellSig = await this.executeTradeLocal(mint, "sell", "100%", false, moonbagExitFee, "MOONBAG_MAX_TP_5X", null, trade._id);
                        if (sellSig) {
                            trade.status = "CLOSED";
                            trade.closedAt = new Date();
                            trade.closeReason = "MOONBAG_MAX_TP_5X";
                            await trade.save();
                        } else {
                            console.warn(`[TRADE-ENGINE] ⚠️ Moonbag 5x sell for ${mint} unconfirmed on-chain. Moonbag remains active.`);
                        }
                    } finally {
                        this.tradeExecutionLocks.delete(tradeIdStr);
                    }
                    continue;
                }

                // 5B. Trailing Stop: Pullback -20% from highest post-TP peak
                if (dropFromPeak <= -0.20) {
                    console.log(`[TRADE-ENGINE] 🛑 Moonbag Trailing Stop (-20%) Triggered on ${mint}! Peak: ${trade.highestMarketCapPostTP.toFixed(2)} SOL ($${(trade.highestMarketCapPostTP * solPrice).toFixed(0)}) | Current: ${currentMC.toFixed(2)} SOL ($${currentMC_USD.toFixed(0)}) | Drop: ${(dropFromPeak * 100).toFixed(1)}%. Selling remaining 25% moonbag!`);

                    this.tradeExecutionLocks.add(tradeIdStr);
                    try {
                        const sellSig = await this.executeTradeLocal(mint, "sell", "100%", false, moonbagExitFee, "TRAILING_STOP_MOONBAG", null, trade._id);
                        if (sellSig) {
                            trade.status = "CLOSED";
                            trade.closedAt = new Date();
                            trade.closeReason = "TRAILING_STOP_MOONBAG";
                            await trade.save();
                        } else {
                            console.warn(`[TRADE-ENGINE] ⚠️ Moonbag trailing stop sell for ${mint} unconfirmed on-chain. Moonbag remains active.`);
                        }
                    } finally {
                        this.tradeExecutionLocks.delete(tradeIdStr);
                    }
                    continue;
                }

                // 5C. Hard Moonbag Floor (Entry Price / 1.00x): Never let moonbag round-trip into a loss!
                if (ratio <= 1.00) {
                    console.log(`[TRADE-ENGINE] 🛡️ Moonbag Entry Floor Triggered on ${mint}! Price retraced to entry (${ratio.toFixed(2)}x). Cashing out remaining 25% bag at breakeven!`);

                    this.tradeExecutionLocks.add(tradeIdStr);
                    try {
                        const sellSig = await this.executeTradeLocal(mint, "sell", "100%", false, moonbagExitFee, "MOONBAG_ENTRY_FLOOR", null, trade._id);
                        if (sellSig) {
                            trade.status = "CLOSED";
                            trade.closedAt = new Date();
                            trade.closeReason = "MOONBAG_ENTRY_FLOOR";
                            await trade.save();
                        } else {
                            console.warn(`[TRADE-ENGINE] ⚠️ Moonbag floor sell for ${mint} unconfirmed on-chain. Moonbag remains active.`);
                        }
                    } finally {
                        this.tradeExecutionLocks.delete(tradeIdStr);
                    }
                    continue;
                }

                // 5D. Moonbag 30-Min Expiration Timeout
                if (minutesSinceTP >= 30 && (dropFromPeak <= -0.10 || minutesSinceTP >= 45)) {
                    console.log(`[TRADE-ENGINE] ⏳ Moonbag 30-Min Expiration Triggered on ${mint}! ${minutesSinceTP.toFixed(1)}m elapsed post-TP. Cashing out remaining 25% bag into SOL before token dies!`);

                    this.tradeExecutionLocks.add(tradeIdStr);
                    try {
                        const sellSig = await this.executeTradeLocal(mint, "sell", "100%", false, moonbagExitFee, "MOONBAG_TIMEOUT_30M", null, trade._id);
                        if (sellSig) {
                            trade.status = "CLOSED";
                            trade.closedAt = new Date();
                            trade.closeReason = "MOONBAG_TIMEOUT_30M";
                            await trade.save();
                        } else {
                            console.warn(`[TRADE-ENGINE] ⚠️ Moonbag timeout sell for ${mint} unconfirmed on-chain. Moonbag remains active.`);
                        }
                    } finally {
                        this.tradeExecutionLocks.delete(tradeIdStr);
                    }
                    continue;
                }
            }
        }
    }

    async checkBondingCurveStatus(mint) {
        if (!mint || typeof mint !== 'string' || !mint.endsWith('pump')) {
            return { exists: false, isComplete: false };
        }
        try {
            const pub = new PublicKey(mint);
            const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
            const [bondingCurve] = PublicKey.findProgramAddressSync(
                [Buffer.from('bonding-curve'), pub.toBuffer()],
                PUMP_PROGRAM
            );
            const acc = await solanaService.connection.getAccountInfo(bondingCurve);
            if (!acc || !acc.data || acc.data.length < 49) {
                return { exists: false, isComplete: false };
            }
            // Byte at offset 48 is the Anchor 'complete' boolean flag
            const isComplete = acc.data.readUInt8(48) === 1;
            return { exists: true, isComplete };
        } catch {
            return { exists: false, isComplete: false };
        }
    }

    /** Live bonding curve reserves for a pump.fun token, or null if unavailable or migrated. */
    async readBondingCurve(mint) {
        if (!mint || typeof mint !== 'string' || !mint.endsWith('pump')) return null;
        try {
            const pub = new PublicKey(mint);
            const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
            const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), pub.toBuffer()], PUMP_PROGRAM);
            const acc = await solanaService.connection.getAccountInfo(bondingCurve);
            if (!acc || !acc.data || acc.data.length < 49) return null;
            const curve = {
                virtualTokenReserves: Number(acc.data.readBigUInt64LE(8)),
                virtualSolReserves: Number(acc.data.readBigUInt64LE(16)),
                complete: acc.data.readUInt8(48) === 1
            };
            if (curve.complete || curve.virtualTokenReserves <= 0 || curve.virtualSolReserves <= 0) return null;
            return curve;
        } catch {
            return null;
        }
    }

    /** Best current market cap in SOL for a token, from the freshest source we have. */
    async getCurrentMcSol(mint) {
        const cached = this.lastMcSol.get(mint);
        if (cached && (Date.now() - cached.t) < 20000) return cached.mc;
        const solPrice = solanaService.getSolPriceUSD();
        if (solPrice > 0) {
            try {
                const meta = await this.resolveTokenMetadata(mint);
                if (meta && meta.marketCapUSD > 0) {
                    const mc = meta.marketCapUSD / solPrice;
                    this.lastMcSol.set(mint, { mc, t: Date.now() });
                    return mc;
                }
            } catch {}
        }
        return cached ? cached.mc : 0;
    }

    /** Size the next buy from the live (or paper) balance. Returns { sizeSol, reason, balanceSol }. */
    async sizeNextTrade() {
        let balanceSol;
        if (this.cfg.isPaper) {
            balanceSol = await this.getPaperBalance();
        } else {
            await this.updateMyBalance(5000);
            balanceSol = this.myBalance;
        }
        const sizing = computeTradeSize({
            balanceSol,
            fraction: this.cfg.tradeFraction,
            minTradeSol: this.cfg.minTradeSol,
            maxTradeSol: this.cfg.maxTradeSol,
            reserveSol: this.cfg.reserveSol,
            slippagePct: this.cfg.buySlippagePct
        });
        return { ...sizing, balanceSol };
    }

    /** Markdown reference for a fill: a Solscan link for real transactions, a label for paper ones. */
    txRef(signature) {
        return String(signature || '').startsWith('PAPER-')
            ? '🧪 simulated, paper mode'
            : `[View on Solscan](https://solscan.io/tx/${signature})`;
    }

    /** Filter that keeps paper and live trades from blocking or closing each other. */
    modeFilter(mode = this.cfg.mode) {
        return mode === 'paper' ? { mode: 'paper' } : { mode: { $ne: 'paper' } };
    }

    /** Virtual balance for paper mode: starting stake plus everything paper trades made or lost. */
    async getPaperBalance() {
        try {
            const rows = await ActiveTrade.aggregate([
                { $match: { mode: 'paper' } },
                { $group: { _id: null, spent: { $sum: '$solSpent' }, received: { $sum: '$solReceived' }, rent: { $sum: '$rentReclaimed' } } }
            ]);
            const r = rows[0] || { spent: 0, received: 0, rent: 0 };
            return Math.max(0, this.cfg.paperStartSol + (r.received || 0) + (r.rent || 0) - (r.spent || 0));
        } catch (e) {
            return this.cfg.paperStartSol;
        }
    }

    /** Tell the admin WHY an order did not go through. Never silent. */
    async notifyFailure(action, mint, reason, detail = '') {
        console.error(`[TRADE-ENGINE] ❌ ${action.toUpperCase()} failed for ${mint}: ${reason}${detail ? ` (${detail})` : ''}`);
        try {
            const telegramService = require('./telegram.service');
            const clean = t => String(t).replace(/[_*`\[\]]/g, ' ');
            await telegramService.sendAdminDirectMessage(
`❌ *${action.toUpperCase()} DID NOT EXECUTE*\n` +
`🏷️ *CA:* \`${mint}\`\n` +
`🧾 *Reason:* ${clean(reason)}` +
(detail ? `\nℹ️ ${clean(detail)}` : '')
            );
        } catch {}
    }

    /** Kept for older call sites. 'unknown' is reported separately from 'failed'. */
    async confirmTransactionSafe(signature, maxWaitMs = this.cfg.confirmTimeoutMs) {
        const res = await solanaService.confirmSignature(signature, maxWaitMs);
        return { confirmed: res.status === 'confirmed', unknown: res.status === 'unknown', err: res.err };
    }

    /**
     * Simulated order. Prices come from the live bonding curve when the token is
     * still on it (so our own price impact is included), otherwise from the live
     * market cap. Assumed slippage and fees are then applied on top.
     */
    async executePaperTrade({ mint, action, amount, priorityFee, source, mirroredWallet, trade, tradeId, isReentry, convictionTier }) {
        const supply = (trade && trade.tokenSupply) || await solanaService.getTokenSupplySafe(mint);
        const fee = this.cfg.paperFeePct / 100;
        const slip = this.cfg.paperSlippagePct / 100;
        let fill = null;
        let priceSource = 'market cap';

        const curve = await this.readBondingCurve(mint);
        if (action === 'buy') {
            const balance = await this.getPaperBalance();
            if (balance < amount + this.cfg.reserveSol) {
                console.log(`[TRADE-ENGINE] 📝 Paper balance ${balance.toFixed(4)} SOL cannot fund a ${amount} SOL buy. Skipped.`);
                return null;
            }
            if (curve) {
                const q = curveBuyTokens(curve, amount * (1 - fee));
                if (q) {
                    const tokens = q.tokensOut * (1 - slip);
                    fill = { solDelta: -(amount + BASE_FEE_SOL + priorityFee + TOKEN_ACCOUNT_RENT_SOL), tokenDelta: tokens, feeSol: BASE_FEE_SOL + priorityFee, rentSol: TOKEN_ACCOUNT_RENT_SOL };
                    priceSource = 'bonding curve';
                }
            }
            if (!fill) {
                const mcSol = await this.getCurrentMcSol(mint);
                fill = supply > 0 && mcSol > 0
                    ? paperFill({ action: 'buy', amountSol: amount, priceSolPerToken: mcSol / supply, slippagePct: this.cfg.paperSlippagePct, feePct: this.cfg.paperFeePct, priorityFeeSol: priorityFee })
                    : null;
            }
        } else {
            if (!trade) {
                console.log(`[TRADE-ENGINE] 📝 Paper sell requested for ${mint} but there is no paper position.`);
                return null;
            }
            const remaining = Math.max(0, (trade.tokensReceived || 0) - (trade.tokensSold || 0));
            const fraction = parseSellFraction(amount);
            if (remaining <= 0) {
                if (trade.status !== 'CLOSED') {
                    trade.status = 'CLOSED';
                    trade.closedAt = new Date();
                    trade.closeReason = source;
                    await trade.save();
                }
                return null;
            }
            if (curve) {
                const q = curveSellSol(curve, remaining * fraction);
                if (q) {
                    const sol = q.solOut * (1 - fee) * (1 - slip) - BASE_FEE_SOL - priorityFee;
                    fill = { solDelta: sol, tokenDelta: -(remaining * fraction), feeSol: BASE_FEE_SOL + priorityFee, rentSol: 0 };
                    priceSource = 'bonding curve';
                }
            }
            if (!fill) {
                const mcSol = await this.getCurrentMcSol(mint);
                fill = supply > 0 && mcSol > 0
                    ? paperFill({ action: 'sell', sellFraction: fraction, remainingTokens: remaining, priceSolPerToken: mcSol / supply, slippagePct: this.cfg.paperSlippagePct, feePct: this.cfg.paperFeePct, priorityFeeSol: priorityFee })
                    : null;
            }
        }

        if (!fill) {
            await this.notifyFailure(action, mint, 'No live price available to simulate this order', 'Paper mode. Nothing was sent.');
            return null;
        }

        const signature = `PAPER-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        console.log(`[TRADE-ENGINE] 📝 PAPER ${action.toUpperCase()} ${mint} via ${priceSource}: SOL ${fill.solDelta.toFixed(5)}, tokens ${fill.tokenDelta.toFixed(2)}`);
        await this.recordFill({ mode: 'paper', mint, action, amount, fill, signature, source, mirroredWallet, trade, tradeId, isReentry, convictionTier, priorityFee, supply });
        return signature;
    }

    /**
     * Single place where a confirmed (or simulated) fill is written to the database
     * and announced. Everything the stats show comes from what is recorded here.
     */
    async recordFill({ mode, mint, action, amount, fill, signature, source, mirroredWallet, trade, tradeId, isReentry, convictionTier, priorityFee, supply }) {
        const telegramService = require('./telegram.service');
        const isPaper = mode === 'paper';
        const tag = isPaper ? '📝 *[PAPER]*' : '*[MY TRADE]*';
        const solPrice = solanaService.getSolPriceUSD();
        const tokenData = await this.resolveTokenMetadata(mint);
        const tokenName = tokenData ? `${tokenData.name} (${tokenData.symbol})` : 'Solana Token';
        const links = getTokenLinks(mint);
        const txLine = isPaper
            ? `🧪 *Simulated fill.* No funds moved.`
            : `🔗 *Verified TX:* [View on Solscan](https://solscan.io/tx/${signature})`;

        if (action === 'buy') {
            const tokenSupply = supply || await solanaService.getTokenSupplySafe(mint);
            const hasFill = Boolean(fill) && fill.tokenDelta > 0 && fill.solDelta < 0;
            const solSpent = hasFill ? -fill.solDelta : 0;
            const rentPaid = hasFill ? (fill.rentSol || 0) : 0;
            const tokens = hasFill ? fill.tokenDelta : 0;
            const feesSol = hasFill ? (fill.feeSol || 0) : 0;

            // Entry reference = what WE paid, not a market snapshot taken later.
            let entryPriceSol = hasFill ? (solSpent - rentPaid) / tokens : 0;
            let entryMcSol = entryPriceSol > 0 && tokenSupply > 0 ? entryPriceSol * tokenSupply : 0;
            if (entryMcSol <= 0) entryMcSol = await this.getCurrentMcSol(mint);
            const entryMcUsd = entryMcSol * solPrice;

            const existing = trade && trade.status !== 'CLOSED'
                ? trade
                : await ActiveTrade.findOne({ mint, status: { $in: OPEN_STATUSES }, ...this.modeFilter(mode) }).sort({ createdAt: -1 });

            if (existing && (isReentry || source === 'MANUAL_BUY_MORE')) {
                // Adding to a position: blend the entry so the exit rules measure against the true average cost.
                const totalTokens = (existing.tokensReceived || 0) + tokens;
                const totalCost = (existing.solSpent || 0) - (existing.rentPaid || 0) + (solSpent - rentPaid);
                existing.solSpent = (existing.solSpent || 0) + solSpent;
                existing.rentPaid = (existing.rentPaid || 0) + rentPaid;
                existing.tokensReceived = totalTokens;
                existing.feesSol = (existing.feesSol || 0) + feesSol;
                existing.amountSolInvested = (existing.amountSolInvested || 0) + (Number(amount) || 0);
                if (hasFill && existing.entryPriceSol > 0 && totalTokens > 0) {
                    existing.entryPriceSol = totalCost / totalTokens;
                    existing.entryMarketCap = existing.entryPriceSol * (existing.tokenSupply || tokenSupply);
                    existing.entryMarketCapUSD = existing.entryMarketCap * solPrice;
                }
                if (!hasFill) existing.accountingIncomplete = true;
                if (isReentry) existing.status = 'REENTERED';
                await existing.save();
                console.log(`[TRADE-ENGINE] 🔄 Added to existing ${mode} position ${existing._id} for ${mint}.`);
            } else {
                const allowedSources = ['COPY_TRADE', 'MILESTONE_SNIPE', 'MANUAL_BUY_MORE', 'MANUAL'];
                await ActiveTrade.create({
                    mint,
                    tokenName,
                    mode,
                    entryPrice: tokenSupply > 0 ? entryMcUsd / tokenSupply : 0,
                    entryMarketCap: entryMcSol,
                    entryMarketCapUSD: entryMcUsd,
                    amountSolInvested: Number(amount) || 0,
                    tokensReceived: tokens,
                    solSpent,
                    rentPaid,
                    feesSol,
                    entryPriceSol,
                    tokenSupply,
                    buySignature: signature,
                    accountingIncomplete: !hasFill,
                    status: 'OPEN',
                    source: allowedSources.includes(source) ? source : 'MANUAL',
                    mirroredWallet,
                    convictionTier,
                    priorityFeePaid: priorityFee
                });
                console.log(`[TRADE-ENGINE] 💾 Saved ${mode} trade for ${mint}. Entry MC ${entryMcSol.toFixed(2)} SOL, all in cost ${solSpent.toFixed(5)} SOL${hasFill ? '' : ' (fill data missing, excluded from stats)'}.`);
                if (!entryMcSol) {
                    await this.notifyFailure('buy', mint, 'Position opened but no entry price could be established', 'Exit rules will start measuring from the next price update.');
                }
            }

            const wsService = require('./pumpportal.service');
            wsService.watchToken(mint);

            const modeDesc = source === 'COPY_TRADE'
                ? `Mirrored Whale [\`${mirroredWallet ? mirroredWallet.substring(0, 4) + '...' + mirroredWallet.substring(mirroredWallet.length - 4) : 'Whale'}\`](https://solscan.io/account/${mirroredWallet})`
                : (source === 'MILESTONE_SNIPE' ? '🔫 Milestone Snipe' : 'Manual');
            const costLine = hasFill
                ? `💰 *All In Cost:* \`${solSpent.toFixed(5)} SOL\`${solPrice ? ` (~$${(solSpent * solPrice).toFixed(2)})` : ''}\n📦 *Tokens:* \`${tokens.toLocaleString('en-US', { maximumFractionDigits: 0 })}\`\n⛽ *Fees:* \`${feesSol.toFixed(6)} SOL\` + \`${rentPaid.toFixed(5)} SOL\` refundable deposit`
                : `💰 *Order Size:* \`${Number(amount).toFixed(4)} SOL\` (fill details unavailable)`;

            const buyAlertAdmin =
`🟢 ${tag} *RAZOR BUY ${isPaper ? 'SIMULATED' : 'CONFIRMED'}*\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${mint}\`\n` +
`${costLine}\n` +
`📈 *Entry MC:* ${formatMarketCap(entryMcUsd)}\n` +
`🎯 *Mode:* ${modeDesc}\n` +
`${txLine}\n` +
`━━━━━━━━━━━━━━━━━━━━`;

            const buyAlertGroup = isPaper ? null :
`🟢🚀 *[MY TRADE] RAZOR BOT BUY CONFIRMED* ⚡🟢\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`✅ _Confirmed On-Chain on Solana Blockchain_\n\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${mint}\`\n` +
`💰 *Trade Size:* \`${Number(amount).toFixed(4)} SOL\`\n` +
`🎯 *Strategy:* 🎯 Top Trader Mirror Snipe\n` +
`🔗 *Verified TX:* [View on Solscan](https://solscan.io/tx/${signature})\n` +
`━━━━━━━━━━━━━━━━━━━━`;

            // Paper fills go to the admin only. The public channel never sees a simulated trade as a real one.
            if (isPaper) await telegramService.sendAdminDirectMessage(buyAlertAdmin);
            else telegramService.sendAlert(buyAlertAdmin, buyAlertGroup, mint);
            return;
        }

        // ---- SELL ----
        const hasFill = Boolean(fill) && fill.tokenDelta < 0;
        const isFullExit = parseSellFraction(amount) >= 1;
        let pnlLine = '';
        if (trade) {
            const update = { $push: { sellSignatures: signature } };
            if (hasFill) {
                update.$inc = { solReceived: fill.solDelta, tokensSold: -fill.tokenDelta, feesSol: fill.feeSol || 0 };
                if (isPaper && isFullExit && (trade.rentPaid || 0) > 0) {
                    update.$inc.rentReclaimed = Math.max(0, trade.rentPaid - BASE_FEE_SOL);
                }
            } else {
                update.$set = { accountingIncomplete: true };
            }
            await ActiveTrade.updateOne({ _id: trade._id }, update);

            if (hasFill && (trade.solSpent || 0) > 0 && !trade.accountingIncomplete) {
                const receivedSoFar = (trade.solReceived || 0) + fill.solDelta;
                if (isFullExit) {
                    const pnl = receivedSoFar + (isPaper ? Math.max(0, (trade.rentPaid || 0) - BASE_FEE_SOL) : 0) - trade.solSpent;
                    const pct = (pnl / trade.solSpent) * 100;
                    pnlLine = `📊 *Realized PnL:* ${pnl >= 0 ? '🟢 +' : '🔴 '}\`${pnl.toFixed(5)} SOL\` (${pnl >= 0 ? '+' : ''}${pct.toFixed(1)}%)${isPaper ? '' : ' before deposit refund'}\n`;
                } else {
                    pnlLine = `💵 *Received:* \`${fill.solDelta.toFixed(5)} SOL\` (total back so far \`${receivedSoFar.toFixed(5)}\` of \`${trade.solSpent.toFixed(5)}\` spent)\n`;
                }
            }
        }

        const triggerLabels = {
            MOONBAG_MAX_TP_5X: '🚀 5x Max Target Hit',
            MAX_TP_5X: '🚀 5x Max Target Hit',
            TAKE_PROFIT_1_4X: '🎯 1.4x Take Profit (sold 75%, holding 25%)',
            TAKE_PROFIT_2X: '🎯 2x Take Profit (sold 75%, holding 25%)',
            BREAKEVEN_STOP: '🛡️ Breakeven Guard (peaked above +20%, exited near entry)',
            TIMEOUT_STAGNANT_15M: '⏳ 15 Min Stagnation Guard',
            STOP_LOSS_28: '🛑 Stop Loss Guard',
            STOP_LOSS_54: '🛑 Stop Loss Guard',
            TRAILING_STOP_MOONBAG: '🪂 Moonbag Trailing Stop',
            MOONBAG_ENTRY_FLOOR: '🛡️ Moonbag Entry Floor',
            MOONBAG_TIMEOUT_30M: '⏳ Moonbag 30 Min Expiration',
            WHALE_MIRROR: '🪞 Mirrored Whale Exit',
            COPY_TRADE: '🪞 Mirrored Whale Exit',
            MANUAL_TELEGRAM: '⚡ Manual Admin Exit',
            MANUAL_PANIC: '⚡ Manual Admin Emergency Exit'
        };
        const triggerDesc = triggerLabels[source] || (isReentry ? '🦅 Dip Re-entry Take Profit' : 'Exit Rule');

        const sellAlert =
`💰 ${tag} *RAZOR SELL ${isPaper ? 'SIMULATED' : 'CONFIRMED'}*\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${mint}\`\n` +
`🎯 *Exit Trigger:* ${triggerDesc}\n` +
`📤 *Sold:* \`${amount}\` of position\n` +
`${pnlLine}` +
`${txLine}\n` +
`━━━━━━━━━━━━━━━━━━━━`;

        if (!this.recentAlertsCache) this.recentAlertsCache = new Set();
        const alertKey = `${mode}_${mint}_${source}`;
        if (!this.recentAlertsCache.has(alertKey)) {
            this.recentAlertsCache.add(alertKey);
            setTimeout(() => this.recentAlertsCache.delete(alertKey), 45000);
            if (isPaper) await telegramService.sendAdminDirectMessage(sellAlert);
            else telegramService.sendAlert(sellAlert, sellAlert, mint);
        }

        const closeId = tradeId || (trade && isFullExit ? trade._id : null);
        if (closeId && source !== 'TAKE_PROFIT_1_4X' && source !== 'TAKE_PROFIT_2X') {
            await ActiveTrade.updateOne(
                { _id: closeId, status: { $ne: 'CLOSED' } },
                { $set: { status: 'CLOSED', closedAt: new Date(), closeReason: source } }
            );
        }
    }

    /** After a full live exit, close the empty token account and book the refunded deposit. */
    async reclaimRent(mint, tradeDocId) {
        if (!this.cfg.closeTokenAccounts || !this.myKeypair) return;
        try {
            // Give the sell a moment to settle so the account reads as empty.
            await new Promise(r => setTimeout(r, 4000));
            const res = await solanaService.closeEmptyTokenAccounts(this.myKeypair, mint);
            if (res.reclaimedSol > 0) {
                console.log(`[TRADE-ENGINE] ♻️ Closed empty token account for ${mint}. Recovered ${res.reclaimedSol.toFixed(5)} SOL.`);
                if (tradeDocId) {
                    await ActiveTrade.updateOne({ _id: tradeDocId }, { $inc: { rentReclaimed: res.reclaimedSol } });
                }
            }
        } catch (e) {
            console.warn(`[TRADE-ENGINE] ⚠️ Could not close token account for ${mint}: ${e.message}`);
        }
    }

    async executeTradeLocal(mint, action, amount, denominatedInSol, priorityFee, source, mirroredWallet = null, tradeId = null, isReentry = false, convictionTier = 'STANDARD', forcePool = null) {
        // Which position does this order belong to?
        let trade = null;
        try {
            if (tradeId) trade = await ActiveTrade.findById(tradeId);
            if (!trade && action === 'sell') {
                trade = await ActiveTrade.findOne({ mint, status: { $in: OPEN_STATUSES } }).sort({ createdAt: -1 });
            }
        } catch {}

        // Buys follow the configured mode. Sells follow the mode the position was opened in.
        const isPaper = action === 'buy' ? this.cfg.isPaper : Boolean(trade && trade.mode === 'paper');
        if (isPaper) {
            try {
                return await this.executePaperTrade({ mint, action, amount, priorityFee, source, mirroredWallet, trade, tradeId, isReentry, convictionTier });
            } catch (err) {
                console.error('[TRADE-ENGINE] ❌ Paper trade error:', err.message);
                return null;
            }
        }
        if (action === 'sell' && this.cfg.isPaper && !trade) {
            console.log(`[TRADE-ENGINE] 📝 Paper mode: ignoring sell for ${mint} (no position on record).`);
            return null;
        }

        if (!this.myKeypair) {
            await this.notifyFailure(action, mint, 'Wallet private key is not loaded');
            return null;
        }

        await this.updateMyBalance(3000);
        if (action === 'buy' && this.myBalance < 0.005) {
            console.log(`[TRADE-ENGINE] ℹ️ Insufficient liquid balance (${this.myBalance.toFixed(4)} SOL). Skipping trade broadcast for ${mint}.`);
            return null;
        }
        if (action === 'sell' && this.myBalance < 0.0005) {
            await this.notifyFailure('sell', mint, `Wallet holds ${this.myBalance.toFixed(5)} SOL, not enough to pay the network fee for the exit`, 'Fund the wallet to let the exit through.');
            return null;
        }

        // Token balance before the order. null means "could not read", which is not the same as zero.
        const preTokenBal = await solanaService.getTokenBalance(this.myWalletKey, mint);
        if (action === 'sell' && preTokenBal !== null && preTokenBal <= 0) {
            console.log(`[TRADE-ENGINE] ℹ️ Zero token balance on-chain for ${mint}. Nothing to sell.`);
            if (trade && trade.status !== 'CLOSED') {
                trade.status = 'CLOSED';
                trade.closedAt = new Date();
                trade.closeReason = source;
                await trade.save();
            }
            return null;
        }

        try {
            // Route to the AMM pool directly when the bonding curve has completed.
            let targetPool = forcePool || 'auto';
            if (!forcePool && mint && mint.endsWith('pump')) {
                try {
                    const curve = await this.checkBondingCurveStatus(mint);
                    if (curve && curve.isComplete) targetPool = 'pump-amm';
                } catch {}
            }

            const slippage = action === 'sell' ? this.cfg.sellSlippagePct : this.cfg.buySlippagePct;
            console.log(`[TRADE-ENGINE] 📡 Requesting ${action.toUpperCase()} (${amount}) from PumpPortal for ${mint} [pool ${targetPool}, slippage ${slippage}%]`);
            const response = await axios.post('https://pumpportal.fun/api/trade-local', {
                publicKey: this.myWalletKey,
                action,
                mint,
                amount,
                denominatedInSol: denominatedInSol ? 'true' : 'false',
                slippage,
                priorityFee,
                pool: targetPool
            }, { responseType: 'arraybuffer', timeout: 10000 });

            const buffer = Buffer.from(response.data);
            const asText = buffer.toString('utf8');
            if (asText.startsWith('{') && asText.includes('"error"')) {
                let msg = asText;
                try { msg = JSON.parse(asText).error || asText; } catch {}
                await this.notifyFailure(action, mint, `PumpPortal rejected the order: ${String(msg).slice(0, 160)}`);
                return null;
            }

            const tx = VersionedTransaction.deserialize(new Uint8Array(buffer));
            try {
                tx.message.recentBlockhash = await solanaService.getLatestBlockhashSafe();
            } catch (bhErr) {
                console.warn('[TRADE-ENGINE] ⚠️ Could not fetch a fresh blockhash, using the one PumpPortal supplied:', bhErr.message);
            }
            tx.sign([this.myKeypair]);

            const retryOnAmm = async (errText) => {
                if (errText.includes('6005') && targetPool !== 'pump-amm') {
                    console.log(`[TRADE-ENGINE] 🔄 Token left the bonding curve. Retrying ${action.toUpperCase()} on the AMM pool...`);
                    return await this.executeTradeLocal(mint, action, amount, denominatedInSol, priorityFee, source, mirroredWallet, tradeId, isReentry, convictionTier, 'pump-amm');
                }
                return undefined;
            };

            // Dry run first: a transaction that would fail is never sent, so it never costs a fee.
            const sim = await solanaService.simulateSafe(tx);
            if (!sim.ok) {
                const retried = await retryOnAmm(JSON.stringify(sim.err || ''));
                if (retried !== undefined) return retried;
                await this.notifyFailure(action, mint, describeTxError(sim.err, sim.logs), 'Caught in the dry run. Nothing was sent and no fee was paid.');
                return null;
            }

            let signature;
            try {
                signature = await solanaService.sendTransactionSafe(tx, { skipPreflight: true, maxRetries: 5 });
                console.log(`[TRADE-ENGINE] 📡 Broadcast ${signature}. Waiting for confirmation...`);
            } catch (sendErr) {
                await this.notifyFailure(action, mint, `No RPC accepted the transaction: ${sendErr.message}`);
                return null;
            }

            const conf = await solanaService.confirmSignature(signature, this.cfg.confirmTimeoutMs);
            if (conf.status === 'failed') {
                const retried = await retryOnAmm(JSON.stringify(conf.err || ''));
                if (retried !== undefined) return retried;
                await this.notifyFailure(action, mint, describeTxError(conf.err), `Failed on chain: https://solscan.io/tx/${signature}`);
                return null;
            }

            if (conf.status === 'unknown') {
                // Not seeing a confirmation is NOT proof of failure. Check what the wallet actually holds.
                await new Promise(r => setTimeout(r, 3000));
                const postTokenBal = await solanaService.getTokenBalance(this.myWalletKey, mint);
                const landed = postTokenBal !== null && preTokenBal !== null && (
                    action === 'buy' ? postTokenBal > preTokenBal : postTokenBal < preTokenBal
                );
                if (!landed) {
                    await this.notifyFailure(action, mint, 'Confirmation timed out and the wallet balance does not show the trade', `Status unknown. Check https://solscan.io/tx/${signature} before retrying.`);
                    return null;
                }
                console.log(`[TRADE-ENGINE] ✅ ${action.toUpperCase()} ${signature} reconciled from the wallet balance after a confirmation timeout.`);
            } else {
                console.log(`[TRADE-ENGINE] ✅ Confirmed on chain: https://solscan.io/tx/${signature}`);
            }

            // What did the transaction really do to the wallet?
            let fill = null;
            try {
                const parsed = await solanaService.fetchParsedTransactionSafe(signature);
                fill = parsed ? parseOwnFill(parsed, this.myWalletKey, mint) : null;
            } catch {}
            if (!fill) console.warn(`[TRADE-ENGINE] ⚠️ Could not read the fill for ${signature}. The trade is kept but excluded from PnL stats.`);

            await this.recordFill({ mode: 'live', mint, action, amount, fill, signature, source, mirroredWallet, trade, tradeId, isReentry, convictionTier, priorityFee });

            if (action === 'sell' && parseSellFraction(amount) >= 1) {
                this.reclaimRent(mint, trade ? trade._id : tradeId).catch(() => {});
            }
            return signature;
        } catch (err) {
            const detail = err.response?.data ? Buffer.from(err.response.data).toString('utf8').slice(0, 160) : err.message;
            await this.notifyFailure(action, mint, `Unexpected error: ${detail}`);
            return null;
        }
    }
}

module.exports = new TradeEngine();
