const axios = require('axios');
const bs58 = require('bs58').default || require('bs58');
const { VersionedTransaction, Keypair, Connection } = require('@solana/web3.js');
const solanaService = require('./solana.service');
const WatchedWallet = require('../models/WatchedWallet');
const TokenMetrics = require('../models/TokenMetrics');
const ActiveTrade = require('../models/ActiveTrade');
const WhalePosition = require('../models/WhalePosition');

const { WALLET_PUBLIC_KEY, WALLET_PRIVATE_KEY, SOLANA_RPC_URL } = process.env;

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
        footerButtons: `📊 [DexScreener](https://dexscreener.com/solana/${mint}) | 💊 [Pump.fun](https://pump.fun/${mint}) | 🔎 [Solscan](https://solscan.io/token/${mint})`
    };
}

class TradeEngine {
    constructor() {
        this.connection = new Connection(SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", 'confirmed');
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
        this.tokenCache = new Map(); // In-memory cache to prevent MongoDB flooding
        
        // Clear memory cache every 1 hour to prevent memory leaks from 1000s of tokens
        setInterval(() => {
            console.log(`[TRADE-ENGINE] 🧹 Clearing in-memory token cache (${this.tokenCache.size} tokens removed).`);
            this.tokenCache.clear();
        }, 3600000);
        
        // Settings & Thresholds
        this.earlyCADiscoveryEnabled = false; // Disabled by default per user request
        this.watchlistThresholdUSD = 10000; // Increased to $10,000 USD per user request
        this.MILESTONES = [10000, 20000, 30000, 40000, 50000, 60000, 70000];
        this.STOP_LOSS_FACTOR = 1.2; // 20% drop from entry
        this.TAKE_PROFIT_FACTOR = 2.0; // 2x gain
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

    async updateMyBalance() {
        if(this.myWalletKey) {
            this.myBalance = await solanaService.getSolBalance(this.myWalletKey);
            console.log(`[TRADE-ENGINE] 💰 Updated local wallet balance: ${this.myBalance} SOL`);
        }
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
            await this.evaluateActiveTrades(mint, mc);
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
        const solPrice = solanaService.getSolPriceUSD() || 150;
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
                const currentMCSol = liveMC > 0 ? (liveMC / solPrice) : 0;
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
        const mcUSD = tokenData.marketCapUSD || (tradeEvent.marketCapSol ? tradeEvent.marketCapSol * solanaService.getSolPriceUSD() : 0);
        const mcTracker = formatMarketCap(mcUSD);
        const links = getTokenLinks(tradeEvent.mint);
        const shortWallet = `${watchedWallet.walletAddress.substring(0, 4)}...${watchedWallet.walletAddress.substring(watchedWallet.walletAddress.length - 4)}`;
        const whaleLabel = (watchedWallet.label && watchedWallet.label !== 'Whale Wallet') ? ` *(${watchedWallet.label})*` : '';
        const receivedSol = tradeEvent.solAmount || 0;
        const solPrice = solanaService.getSolPriceUSD();
        const receivedUsd = tradeEvent.usdAmount && tradeEvent.usdAmount > 1 ? tradeEvent.usdAmount : (receivedSol * solPrice);

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

        if (whalePos && whalePos.totalSolInvested > 0) {
            const enteredTotalSol = whalePos.totalSolInvested;
            const enteredTotalTokens = whalePos.totalTokensBought || 0;
            const tokensSoldNow = tradeEvent.tokenAmount || 0;

            // Determine proportion of position sold in this exit transaction
            let sellRatio = 1.0;
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

        // 2. Whale Sell Mirroring: If Razor Bot holds an active copy position for this token, close it!
        let razorActionDesc = 'ℹ️ No Active Position';
        try {
            const activeCopyTrade = await ActiveTrade.findOne({
                mint: tradeEvent.mint,
                status: { $in: ["OPEN", "REENTERED"] },
                source: "COPY_TRADE"
            });

            if (activeCopyTrade) {
                await this.updateMyBalance();
                if (this.myBalance >= 0.005) {
                    console.log(`[TRADE-ENGINE] 🪞 Mirrored Whale Exit triggered for ${tradeEvent.mint}! Executing sell...`);
                    const sellSig = await this.executeTradeLocal(tradeEvent.mint, "sell", "100%", false, 0.0001, "COPY_TRADE", watchedWallet.walletAddress, activeCopyTrade._id);
                    if (sellSig) {
                        activeCopyTrade.status = "CLOSED";
                        await activeCopyTrade.save();
                        razorActionDesc = `🔴 *Sold 100%* (Mirrored Whale Exit ➔ [Solscan](https://solscan.io/tx/${sellSig}))`;
                    } else {
                        razorActionDesc = `⚠️ *Sell Attempted* (Broadcast pending)`;
                    }
                } else {
                    razorActionDesc = `⏸️ *Skipped* (Wallet Unfunded — \`0.0000 SOL\`)`;
                }
            }
        } catch (copyErr) {
            console.warn("[TRADE-ENGINE] ⚠️ Error mirroring whale exit:", copyErr.message);
        }

        const telegramService = require('./telegram.service');

        const cleanAlertMsg =
`📉 *Whale Sell Detected!* 📉\n\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${tradeEvent.mint}\`\n\n` +
`${pnlSection}\n\n` +
`📈 *Current MC:* ${mcTracker}\n\n` +
`${links.footerButtons}`;

        telegramService.sendAlert(cleanAlertMsg, cleanAlertMsg, tradeEvent.mint);
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

        console.log(`[TRADE-ENGINE] 🧮 Calculating Scale Factor for ${watchedWallet.walletAddress}...`);
        const targetWalletBalance = tradeEvent.traderBalanceSol || await solanaService.getSolBalance(watchedWallet.walletAddress);
        const spentSol = tradeEvent.solAmount;
        
        await this.updateMyBalance();
        let myTradeSize = 0;
        let scaleFactor = 0;
        
        if (!targetWalletBalance || targetWalletBalance <= 0) {
            console.log(`[TRADE-ENGINE] ⚠️ [FALLBACK] RPC failed to fetch balance for ${watchedWallet.walletAddress}. Using default 5% allocation.`);
            myTradeSize = this.myBalance * 0.05; 
        } else if (!spentSol) {
            console.log(`[TRADE-ENGINE] ℹ️ No SOL spent parsed from event. Skipping copy trade.`);
            return;
        } else {
            // Normalize scale factor against realistic portfolio floor (prevents 100% on dust trades)
            const effectivePortfolio = Math.max(targetWalletBalance, 5.0);
            scaleFactor = Math.min(1.0, Math.max(0.0001, spentSol / effectivePortfolio));
            myTradeSize = this.myBalance * scaleFactor;
            console.log(`[TRADE-ENGINE] ⚖️ Scale Factor: ${(scaleFactor*100).toFixed(2)}% (Bal: ${targetWalletBalance.toFixed(4)}, Effective: ${effectivePortfolio.toFixed(2)}) | Calculated Trade: ${myTradeSize} SOL`);
        }
        
        // Safeguards
        if(myTradeSize > this.myBalance * 0.1) {
            console.log(`[TRADE-ENGINE] 🛡️ Safeguard: Capping trade size to 10% of portfolio.`);
            myTradeSize = this.myBalance * 0.1; 
        }
        if(myTradeSize < 0.01) {
            console.log(`[TRADE-ENGINE] 🛡️ Safeguard: Adjusting trade size to minimum 0.01 SOL.`);
            myTradeSize = 0.01;
        }

        console.log(`[TRADE-ENGINE] 📊 Fetching Token Metrics for alert formatting...`);
        const tokenData = await this.resolveTokenMetadata(tradeEvent.mint, tradeEvent.marketCapSol);
        const tokenName = tokenData ? `${tokenData.name} (${tokenData.symbol})` : 'Solana Token';
        const mcUSD = tokenData.marketCapUSD || (tradeEvent.marketCapSol ? tradeEvent.marketCapSol * solanaService.getSolPriceUSD() : 0);
        const mcTracker = formatMarketCap(mcUSD);
        const links = getTokenLinks(tradeEvent.mint);
        const shortWallet = `${watchedWallet.walletAddress.substring(0, 4)}...${watchedWallet.walletAddress.substring(watchedWallet.walletAddress.length - 4)}`;
        const whaleLabel = (watchedWallet.label && watchedWallet.label !== 'Whale Wallet') ? ` *(${watchedWallet.label})*` : '';

        const spentDesc = tradeEvent.usdAmount && tradeEvent.usdAmount > 1
            ? `${spentSol.toFixed(4)} SOL (~$${tradeEvent.usdAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} USD)`
            : `${spentSol.toFixed(4)} SOL`;

        // Track Whale Entry Position for PnL / Gain calculation upon exit
        try {
            let whalePos = await WhalePosition.findOne({
                walletAddress: watchedWallet.walletAddress,
                mint: tradeEvent.mint,
                isOpen: true
            });

            const usdInvested = tradeEvent.usdAmount || (spentSol * solanaService.getSolPriceUSD());

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

        const cleanAlertMsg =
`🚨 *Whale Buy Detected!* 🚨\n\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${tradeEvent.mint}\`\n` +
`💰 *Whale Spent:* ${spentDesc}\n` +
`📈 *Current MC:* ${mcTracker}\n\n` +
`${links.footerButtons}`;

        telegramService.sendAlert(cleanAlertMsg, cleanAlertMsg, tradeEvent.mint);

        console.log(`[TRADE-ENGINE] 🚀 Dispatching local buy trade execution...`);
        await this.executeTradeLocal(tradeEvent.mint, "buy", myTradeSize, true, 0.0001, "COPY_TRADE", watchedWallet.walletAddress);
    }

    async evaluateActiveTrades(mint, currentMC) {
        const activeTrades = await ActiveTrade.find({ mint, status: { $in: ["OPEN", "REENTERED"] } });
        
        for(let trade of activeTrades) {
            if(trade.status === "OPEN") {
                if(currentMC <= (trade.entryMarketCap / this.STOP_LOSS_FACTOR)) {
                    console.log(`[TRADE-ENGINE] 🛑 Stop Loss Triggered on ${mint} at MC: $${(currentMC * solanaService.getSolPriceUSD()).toFixed(2)}. Executing sell!`);
                    await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, null, null, trade._id);
                    continue;
                }
                if(currentMC >= (trade.entryMarketCap * this.TAKE_PROFIT_FACTOR)) {
                    console.log(`[TRADE-ENGINE] 💸 Take Profit (2x) Triggered on ${mint} at MC: $${(currentMC * solanaService.getSolPriceUSD()).toFixed(2)}. Securing profit!`);
                    await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, null, null, trade._id);
                    trade.status = "TP_TAKEN_WAITING_REENTRY";
                    await trade.save();
                }
            } else if (trade.status === "REENTERED") {
                 if(currentMC < trade.entryMarketCap) {
                     console.log(`[TRADE-ENGINE] 🛑 Re-entry Stop Loss Triggered on ${mint} at MC: $${(currentMC * solanaService.getSolPriceUSD()).toFixed(2)}. Executing sell!`);
                     await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, null, null, trade._id);
                 }
                 else if(currentMC >= (trade.entryMarketCap * this.TAKE_PROFIT_FACTOR)) {
                     console.log(`[TRADE-ENGINE] 💸 Re-entry Take Profit (2x) Triggered on ${mint}. Securing profit!`);
                     await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, null, null, trade._id);
                 }
            }
        }
        
        const waitingTrades = await ActiveTrade.find({ mint, status: "TP_TAKEN_WAITING_REENTRY" });
        for(let trade of waitingTrades) {
             if(currentMC <= trade.entryMarketCap * 1.05) { 
                 console.log(`[TRADE-ENGINE] 🦅 Dip detected on ${mint}. Re-entering with 50% initial capital at MC: $${(currentMC * solanaService.getSolPriceUSD()).toFixed(2)}`);
                 const reEntryAmount = trade.amountSolInvested * 0.5;
                 await this.executeTradeLocal(mint, "buy", reEntryAmount, true, 0.0001, "MILESTONE_SNIPE", null, trade._id, true);
             }
        }
    }

    async executeTradeLocal(mint, action, amount, denominatedInSol, priorityFee, source, mirroredWallet = null, tradeId = null, isReentry = false) {
        if(!this.myKeypair) {
            console.error("[TRADE-ENGINE] ❌ Missing Wallet Private Key. Cannot execute trade.");
            return null;
        }

        await this.updateMyBalance();
        if (action === "buy" && this.myBalance < 0.005) {
            console.log(`[TRADE-ENGINE] ℹ️ Insufficient liquid balance (${this.myBalance.toFixed(4)} SOL). Skipping trade broadcast for ${mint}.`);
            return null;
        }
        
        try {
            console.log(`[TRADE-ENGINE] 📡 Sending ${action.toUpperCase()} payload to PumpPortal for ${mint}`);
            const response = await axios.post("https://pumpportal.fun/api/trade-local", {
                publicKey: this.myWalletKey,
                action,
                mint,
                amount,
                denominatedInSol: denominatedInSol ? "true" : "false",
                slippage: 15,
                priorityFee,
                pool: "auto"
            }, {
                responseType: 'arraybuffer'
            });
            
            if(response.status === 200) {
                const buffer = Buffer.from(response.data);
                
                // Safety check: PumpPortal might return a JSON error string
                const asText = buffer.toString('utf8');
                if (asText.startsWith('{') && asText.includes('"error"')) {
                    try {
                        const errObj = JSON.parse(asText);
                        console.error("[TRADE-ENGINE] ❌ PumpPortal API Error:", errObj.error || asText);
                        return null;
                    } catch {}
                }

                console.log(`[TRADE-ENGINE] 📝 Received raw transaction from PumpPortal. Signing...`);
                const txBytes = new Uint8Array(buffer);
                const tx = VersionedTransaction.deserialize(txBytes);
                tx.sign([this.myKeypair]);
                
                console.log(`[TRADE-ENGINE] 📤 Broadcasting signed transaction to Solana network...`);
                let signature;
                try {
                    signature = await solanaService.sendTransactionSafe(tx, { maxRetries: 3 });
                    console.log(`[TRADE-ENGINE] ✅ Transaction successful! Signature: https://solscan.io/tx/${signature}`);
                } catch (sendErr) {
                    console.error("[TRADE-ENGINE] ❌ Solana RPC sendTransaction error across all endpoints:", sendErr.message);
                    return null;
                }
                
                const telegramService = require('./telegram.service');

                if(action === "buy") {
                    const tokenData = await this.resolveTokenMetadata(mint);
                    const tokenName = tokenData ? `${tokenData.name} (${tokenData.symbol})` : 'Solana Token';
                    const links = getTokenLinks(mint);
                    const modeDesc = source === 'COPY_TRADE' 
                        ? `Mirrored Whale [\`${mirroredWallet ? mirroredWallet.substring(0,4)+'...'+mirroredWallet.substring(mirroredWallet.length-4) : 'Whale'}\`](https://solscan.io/account/${mirroredWallet})`
                        : '🔫 5K Milestone Snipe ($10k ➔ $50k)';

                    const buyAlert =
`⚡ *RAZOR BOT BUY CONFIRMED* ⚡\n\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${mint}\`\n` +
`💰 *Buy Size:* \`${amount.toFixed(4)} SOL\`\n` +
`🎯 *Mode:* ${modeDesc}\n` +
`🔗 *TX Hash:* [View on Solscan](https://solscan.io/tx/${signature})\n\n` +
`${links.footerButtons}`;

                    telegramService.sendAlert(buyAlert, null, mint);

                    if(isReentry && tradeId) {
                        const trade = await ActiveTrade.findById(tradeId);
                        trade.status = "REENTERED";
                        await trade.save();
                        console.log(`[TRADE-ENGINE] 🔄 Updated trade state to REENTERED for DB record ${tradeId}`);
                    } else {
                         await ActiveTrade.create({
                            mint,
                            entryPrice: 0,
                            entryMarketCap: 0, 
                            amountSolInvested: amount,
                            tokensReceived: 0,
                            source,
                            mirroredWallet
                        });
                        console.log(`[TRADE-ENGINE] 💾 Saved new ActiveTrade record to DB for tracking TP/SL.`);
                        
                        const wsService = require('./pumpportal.service');
                        wsService.watchToken(mint);
                    }
                } else if(action === "sell") {
                    const tokenData = await this.resolveTokenMetadata(mint);
                    const tokenName = tokenData ? `${tokenData.name} (${tokenData.symbol})` : 'Solana Token';
                    const links = getTokenLinks(mint);
                    const sellAlert =
`💸 *RAZOR BOT SELL CONFIRMED* 💸\n\n` +
`🪙 *Token:* [${tokenName}](${links.tokenUrl})\n` +
`🏷️ *CA:* \`${mint}\`\n` +
`🎯 *Trigger:* ${isReentry ? 'Dip Re-entry Take Profit' : 'Take Profit (2x) / Stop Loss Guard'}\n` +
`🔗 *TX Hash:* [View on Solscan](https://solscan.io/tx/${signature})\n\n` +
`${links.footerButtons}`;

                    telegramService.sendAlert(sellAlert, null, mint);

                    if(tradeId) {
                        const trade = await ActiveTrade.findById(tradeId);
                        if(trade.status !== "TP_TAKEN_WAITING_REENTRY") {
                            trade.status = "CLOSED";
                        }
                        await trade.save();
                        console.log(`[TRADE-ENGINE] 💾 Updated ActiveTrade record status to ${trade.status}.`);
                    }
                }
                
                return signature;
            }
        } catch(err) {
            console.error("[TRADE-ENGINE] ❌ Error executing trade:", err.response?.data || err.message);
            return null;
        }
    }
}

module.exports = new TradeEngine();
