const axios = require('axios');
const bs58 = require('bs58').default || require('bs58');
const { VersionedTransaction, Keypair, Connection } = require('@solana/web3.js');
const solanaService = require('./solana.service');
const WatchedWallet = require('../models/WatchedWallet');
const TokenMetrics = require('../models/TokenMetrics');
const ActiveTrade = require('../models/ActiveTrade');

const { WALLET_PUBLIC_KEY, WALLET_PRIVATE_KEY, SOLANA_RPC_URL } = process.env;

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
        
        // Constants for logic
        this.MILESTONES = [10000, 20000, 30000, 40000, 50000, 60000, 70000];
        this.STOP_LOSS_FACTOR = 1.2; // 20% drop from entry
        this.TAKE_PROFIT_FACTOR = 2.0; // 2x gain
    }

    async updateMyBalance() {
        if(this.myWalletKey) {
            this.myBalance = await solanaService.getSolBalance(this.myWalletKey);
            console.log(`[TRADE-ENGINE] 💰 Updated local wallet balance: ${this.myBalance} SOL`);
        }
    }

    async handleNewToken(msg) {
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

        // Instruct WebSocket to watch this token so we get MC updates to see if it reaches 7k
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
        if(msg.txType === 'buy' && trader) {
            const watched = await WatchedWallet.findOne({ walletAddress: trader, isActive: true });
            if(watched) {
                console.log(`[TRADE-ENGINE] 🎯 Watched wallet ${trader} bought ${mint}`);
                await this.executeCopyTrade(msg, watched);
            }
        }
        
        // 3. Evaluate if we have an active position (TP/SL)
        if(mint && mc) {
            await this.evaluateActiveTrades(mint, mc);
        }
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

        // 🚨 NEW LOGIC: Only save new tokens to permanent DB if they hit $5,000 MC 🚨
        if(currentMC_USD >= 5000 && !token.isSavedToDB) {
            console.log(`[TRADE-ENGINE] ⭐ Token ${mint} crossed $5k MC! Saving to permanent DB watchlist.`);
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
                // Ignore duplicate keys if multiple trades fire concurrently at 5k
            }
        }
        
        // Check for new milestones
        for(let ms of this.MILESTONES) {
            if(currentMC_USD >= ms && !token.milestonesHit.includes(ms)) {
                console.log(`[TRADE-ENGINE] 🚀 Token ${mint} hit milestone: $${ms} MC!`);
                token.milestonesHit.push(ms);
                updated = true;
                
                // Trigger milestone snipe logic
                await this.evaluateMilestoneSnipe(token, currentMC_USD);
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
        if(token.milestonesHit.includes(10000) && token.milestonesHit.includes(20000)) {
            const existing = await ActiveTrade.findOne({ mint: token.mint });
            if(!existing) {
                console.log(`[TRADE-ENGINE] 🔫 Milestones $10k & $20k hit for ${token.mint}. Executing SNIPING logic to $50k!`);
                const tradeAmountSol = 0.05; // Make this configurable
                await this.executeTradeLocal(token.mint, "buy", tradeAmountSol, true, 0.002, "MILESTONE_SNIPE");
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
        const targetWalletBalance = await solanaService.getSolBalance(watchedWallet.walletAddress);
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
            scaleFactor = spentSol / targetWalletBalance;
            myTradeSize = this.myBalance * scaleFactor;
            console.log(`[TRADE-ENGINE] ⚖️ Scale Factor: ${(scaleFactor*100).toFixed(2)}% | Calculated Trade: ${myTradeSize} SOL`);
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
        let tokenData = this.tokenCache.get(tradeEvent.mint);
        if(!tokenData) {
            tokenData = await TokenMetrics.findOne({ mint: tradeEvent.mint });
        }
        const tokenName = tokenData ? `${tokenData.name} (${tokenData.symbol})` : 'Unknown Token';
        const mcTracker = tradeEvent.marketCapSol ? `$${(tradeEvent.marketCapSol * solanaService.getSolPriceUSD()).toFixed(2)}` : 'Unknown';
        const shortWallet = `${watchedWallet.walletAddress.substring(0, 4)}...${watchedWallet.walletAddress.substring(watchedWallet.walletAddress.length - 4)}`;

        const telegramService = require('./telegram.service');
        const alertMsg = `🚨 *Whale Buy Detected!* 🚨\n\n👤 *Whale:* [\`${shortWallet}\`](https://solscan.io/account/${watchedWallet.walletAddress})\n🪙 *Token:* [${tokenName}](https://pump.fun/${tradeEvent.mint})\n🏷️ *CA:* \`${tradeEvent.mint}\`\n💰 *Whale Spent:* ${spentSol.toFixed(4)} SOL\n📈 *Current MC:* ${mcTracker}\n\n🗡️ *Razor Bot Execution:*\n*Buy Amount:* ${myTradeSize.toFixed(4)} SOL (Scale: ${(scaleFactor*100).toFixed(2)}%)\n\n📊 [DexScreener](https://dexscreener.com/solana/${tradeEvent.mint}) | 💊 [Pump.fun](https://pump.fun/${tradeEvent.mint})`;
        telegramService.sendAlert(alertMsg);

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
            return;
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
            });
            
            if(response.status === 200) {
                console.log(`[TRADE-ENGINE] 📝 Received raw transaction from PumpPortal. Signing...`);
                const txBytes = new Uint8Array(response.data);
                const tx = VersionedTransaction.deserialize(txBytes);
                tx.sign([this.myKeypair]);
                
                console.log(`[TRADE-ENGINE] 📤 Broadcasting signed transaction to Solana network...`);
                const signature = await this.connection.sendTransaction(tx, { maxRetries: 3 });
                console.log(`[TRADE-ENGINE] ✅ Transaction successful! Signature: https://solscan.io/tx/${signature}`);
                
                if(action === "buy") {
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
                } else if(action === "sell" && tradeId) {
                     const trade = await ActiveTrade.findById(tradeId);
                     if(trade.status !== "TP_TAKEN_WAITING_REENTRY") {
                         trade.status = "CLOSED";
                     }
                     await trade.save();
                     console.log(`[TRADE-ENGINE] 💾 Updated ActiveTrade record status to ${trade.status}.`);
                }
                
                return signature;
            }
        } catch(err) {
            console.error("[TRADE-ENGINE] ❌ Error executing trade:", err.response?.data || err.message);
        }
    }
}

module.exports = new TradeEngine();
