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
            } catch(e) {
                console.error("Failed to decode private key", e);
            }
        }
        
        // Caching
        this.myBalance = 0;
        
        // Constants for logic
        this.MILESTONES = [10000, 20000, 30000, 40000, 50000, 60000, 70000];
        this.STOP_LOSS_FACTOR = 1.2; // 20% drop from entry
        this.TAKE_PROFIT_FACTOR = 2.0; // 2x gain
    }

    async updateMyBalance() {
        if(this.myWalletKey) {
            this.myBalance = await solanaService.getSolBalance(this.myWalletKey);
        }
    }

    async handleNewToken(msg) {
        // Message format for create usually has mint, traderPublicKey, initialMarketCap, etc.
        const mint = msg.mint;
        const initialMC = msg.marketCapSol || 0; // The actual field depends on WS payload, assume marketCapSol
        
        await TokenMetrics.create({
            mint,
            symbol: msg.symbol || 'UNK',
            name: msg.name || 'Unknown',
            initialMC,
            highestMCReached: initialMC,
            milestonesHit: [],
            isRugged: false
        });
        
        // Could automatically subscribe to watch this token if it meets certain criteria
    }

    async handleTradeEvent(msg) {
        // msg comes from subscribeAccountTrade OR subscribeTokenTrade
        // Determine what the message is for
        
        const trader = msg.traderPublicKey;
        const mint = msg.mint;
        const mc = msg.marketCapSol; // Check actual payload property names
        const solAmount = msg.solAmount; 
        
        // 1. Update Token MC and check for milestones
        if(mint && mc) {
            await this.updateTokenMilestones(mint, mc);
        }
        
        // 2. Evaluate if it's a watched wallet trade (Copy Trade)
        if(msg.txType === 'buy' && trader) {
            const watched = await WatchedWallet.findOne({ walletAddress: trader, isActive: true });
            if(watched) {
                await this.executeCopyTrade(msg, watched);
            }
        }
        
        // 3. Evaluate if we have an active position (TP/SL)
        if(mint && mc) {
            await this.evaluateActiveTrades(mint, mc);
        }
    }

    async updateTokenMilestones(mint, currentMC) {
        // Find token metrics
        const token = await TokenMetrics.findOne({ mint });
        if(!token) return; // Not tracked
        
        let updated = false;
        if(currentMC > token.highestMCReached) {
            token.highestMCReached = currentMC;
            updated = true;
        }
        
        // Check for new milestones
        for(let ms of this.MILESTONES) {
            if(currentMC >= ms && !token.milestonesHit.includes(ms)) {
                token.milestonesHit.push(ms);
                updated = true;
                
                // Trigger milestone snipe logic
                await this.evaluateMilestoneSnipe(token, currentMC);
            }
        }
        
        if(updated) {
            await token.save();
        }
    }
    
    async evaluateMilestoneSnipe(token, currentMC) {
        // "If it passes 10k and 20k that means it ready to stay to 50k"
        if(token.milestonesHit.includes(10000) && token.milestonesHit.includes(20000)) {
            // Did we already buy it?
            const existing = await ActiveTrade.findOne({ mint: token.mint });
            if(!existing) {
                // Execute Sniper Trade
                console.log(`:::> Milestones 10k & 20k hit for ${token.mint}. SNIPING to 50k!`);
                
                // Determine trade amount (default snipe size e.g. 0.05 SOL or $10 eq)
                const tradeAmountSol = 0.05; // Make this configurable
                
                // We pass priorityFee high for Sniper
                await this.executeTradeLocal(token.mint, "buy", tradeAmountSol, true, 0.002, "MILESTONE_SNIPE");
            }
        }
    }

    async executeCopyTrade(tradeEvent, watchedWallet) {
        // Calculate Gain Factor
        const targetWalletBalance = await solanaService.getSolBalance(watchedWallet.walletAddress);
        const spentSol = tradeEvent.solAmount;
        
        await this.updateMyBalance();
        let myTradeSize = 0;
        
        // Fallback Mechanism if RPC fails to return a valid balance for target wallet
        if (!targetWalletBalance || targetWalletBalance <= 0) {
            console.log(`:::> [FALLBACK] RPC failed to fetch balance for ${watchedWallet.walletAddress}. Using default 5% allocation.`);
            myTradeSize = this.myBalance * 0.05; // Fallback to 5% of our balance
        } else if (!spentSol) {
            return;
        } else {
            const scaleFactor = spentSol / targetWalletBalance;
            myTradeSize = this.myBalance * scaleFactor;
            console.log(`:::> Copying trade from ${watchedWallet.walletAddress}. Target spent ${spentSol} SOL (Scale: ${(scaleFactor*100).toFixed(2)}%). Calculated Trade: ${myTradeSize} SOL`);
        }
        
        // Safeguards
        if(myTradeSize > this.myBalance * 0.1) {
            myTradeSize = this.myBalance * 0.1; // Max 10% of portfolio per trade
        }
        if(myTradeSize < 0.01) {
            myTradeSize = 0.01; // Minimum trade
        }

        // Fetch Token details from DB if we have it
        const tokenData = await TokenMetrics.findOne({ mint: tradeEvent.mint });
        const tokenName = tokenData ? `${tokenData.name} (${tokenData.symbol})` : 'Unknown Token';
        const mcTracker = tradeEvent.marketCapSol ? `${tradeEvent.marketCapSol.toFixed(2)} SOL` : 'Unknown';
        
        const shortWallet = `${watchedWallet.walletAddress.substring(0, 4)}...${watchedWallet.walletAddress.substring(watchedWallet.walletAddress.length - 4)}`;

        // Notify Telegram Channel
        const telegramService = require('./telegram.service');
        const alertMsg = `🚨 *Whale Buy Detected!* 🚨

👤 *Whale:* [\`${shortWallet}\`](https://solscan.io/account/${watchedWallet.walletAddress})
🪙 *Token:* [${tokenName}](https://pump.fun/${tradeEvent.mint})
🏷️ *CA:* \`${tradeEvent.mint}\`
💰 *Whale Spent:* ${spentSol.toFixed(4)} SOL
📈 *Current MC:* ${mcTracker}

🗡️ *Razor Bot Execution:*
*Buy Amount:* ${myTradeSize.toFixed(4)} SOL (Scale: ${(scaleFactor*100).toFixed(2)}%)

📊 [DexScreener](https://dexscreener.com/solana/${tradeEvent.mint}) | 💊 [Pump.fun](https://pump.fun/${tradeEvent.mint})`;
        telegramService.sendAlert(alertMsg);

        await this.executeTradeLocal(tradeEvent.mint, "buy", myTradeSize, true, 0.0001, "COPY_TRADE", watchedWallet.walletAddress);
    }

    async evaluateActiveTrades(mint, currentMC) {
        const activeTrades = await ActiveTrade.find({ mint, status: { $in: ["OPEN", "REENTERED"] } });
        
        for(let trade of activeTrades) {
            if(trade.status === "OPEN") {
                // Check SL (drops up to 1.2x)
                if(currentMC <= (trade.entryMarketCap / this.STOP_LOSS_FACTOR)) {
                    console.log(`:::> Stop Loss Triggered on ${mint} at MC: ${currentMC}`);
                    await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, null, null, trade._id);
                    continue;
                }
                
                // Check TP (2x)
                if(currentMC >= (trade.entryMarketCap * this.TAKE_PROFIT_FACTOR)) {
                    console.log(`:::> Take Profit Triggered on ${mint} at MC: ${currentMC}`);
                    await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, null, null, trade._id);
                    // Mark as waiting for reentry
                    trade.status = "TP_TAKEN_WAITING_REENTRY";
                    await trade.save();
                }
            } else if (trade.status === "REENTERED") {
                 // Check SL (cannot drop below reentry MC)
                 if(currentMC < trade.entryMarketCap) {
                     console.log(`:::> Re-entry Stop Loss Triggered on ${mint} at MC: ${currentMC}`);
                     await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, null, null, trade._id);
                 }
                 // Check TP (another 2x from reentry)
                 else if(currentMC >= (trade.entryMarketCap * this.TAKE_PROFIT_FACTOR)) {
                     console.log(`:::> Re-entry Take Profit Triggered on ${mint}`);
                     await this.executeTradeLocal(mint, "sell", "100%", false, 0.0001, null, null, trade._id);
                 }
            }
        }
        
        // Check trades waiting for re-entry
        const waitingTrades = await ActiveTrade.find({ mint, status: "TP_TAKEN_WAITING_REENTRY" });
        for(let trade of waitingTrades) {
             // Wait for dip back to exact initial entry MC (or slightly below)
             if(currentMC <= trade.entryMarketCap * 1.05) { // 5% buffer 
                 console.log(`:::> Dip detected on ${mint}. Re-entering with 50% initial capital!`);
                 const reEntryAmount = trade.amountSolInvested * 0.5;
                 await this.executeTradeLocal(mint, "buy", reEntryAmount, true, 0.0001, "MILESTONE_SNIPE", null, trade._id, true);
             }
        }
    }

    async executeTradeLocal(mint, action, amount, denominatedInSol, priorityFee, source, mirroredWallet = null, tradeId = null, isReentry = false) {
        if(!this.myKeypair) {
            console.error("<::: Missing Wallet Private Key. Cannot execute trade.");
            return;
        }
        
        try {
            console.log(`:::> Sending ${action.toUpperCase()} request to PumpPortal for ${mint}`);
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
                const txBytes = new Uint8Array(response.data);
                const tx = VersionedTransaction.deserialize(txBytes);
                tx.sign([this.myKeypair]);
                
                const signature = await this.connection.sendTransaction(tx, { maxRetries: 3 });
                console.log(`:::> Transaction sent! https://solscan.io/tx/${signature}`);
                
                // Save to DB
                if(action === "buy") {
                    if(isReentry && tradeId) {
                        const trade = await ActiveTrade.findById(tradeId);
                        trade.status = "REENTERED";
                        // Update entry MC for the new leg
                        // Need to fetch current MC or use estimation. We will use a mock value here, 
                        // but normally we get it from WS stream.
                        await trade.save();
                    } else {
                         await ActiveTrade.create({
                            mint,
                            entryPrice: 0, // Need accurate calc
                            entryMarketCap: 0, // Updated by WS immediately after
                            amountSolInvested: amount,
                            tokensReceived: 0, // Need to parse tx receipt
                            source,
                            mirroredWallet
                        });
                        
                        // Notify WS to start tracking this token
                        const wsService = require('./pumpportal.service'); // lazy load to avoid circular deps
                        wsService.watchToken(mint);
                    }
                } else if(action === "sell" && tradeId) {
                     const trade = await ActiveTrade.findById(tradeId);
                     if(trade.status !== "TP_TAKEN_WAITING_REENTRY") {
                         trade.status = "CLOSED";
                     }
                     await trade.save();
                }
                
                return signature;
            }
        } catch(err) {
            console.error("<::: Error executing trade", err.response?.data || err.message);
        }
    }
}

module.exports = new TradeEngine();
