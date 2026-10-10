const WebSocket = require('ws');
const { PUMPPORTAL_API_KEY } = process.env;
const WatchedWallet = require('../models/WatchedWallet');
const TokenMetrics = require('../models/TokenMetrics');
const ActiveTrade = require('../models/ActiveTrade');
const tradeEngine = require('./trade-engine.service');

class PumpPortalService {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.pingInterval = null;
    }

    connect() {
        console.log("[PUMPPORTAL] 🔄 Initializing WebSocket connection to PumpPortal...");
        const uri = `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`;
        this.ws = new WebSocket(uri);

        this.ws.on('open', async () => {
            console.log("[PUMPPORTAL] ✅ Successfully connected to WebSocket.");
            this.reconnectAttempts = 0;
            
            // Subscribe to new tokens
            console.log("[PUMPPORTAL] 📡 Subscribing to new token creation stream...");
            this.ws.send(JSON.stringify({ method: "subscribeNewToken" }));
            
            // Sync watched wallets
            await this.syncWatchedWallets();

            // Sync active trade tokens to watch their MC for TP/SL
            await this.syncActiveTrades();

            // Keep connection alive
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.ping();
                    // console.log("[PUMPPORTAL] 💓 Ping sent to keep connection alive."); // Too noisy for console, keeping commented
                }
            }, 30000);
        });

        this.ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                await this.handleMessage(message);
            } catch (err) {
                console.error("[PUMPPORTAL] ❌ Error processing incoming WS message:", err.message);
            }
        });

        this.ws.on('close', () => {
            console.log("[PUMPPORTAL] ⚠️ WebSocket closed. Reconnecting...");
            clearInterval(this.pingInterval);
            const delay = Math.min(10000, 1000 * Math.pow(2, this.reconnectAttempts++));
            console.log(`[PUMPPORTAL] 🔄 Attempting reconnect in ${delay}ms (Attempt ${this.reconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
        });

        this.ws.on('error', (err) => {
            console.error("[PUMPPORTAL] 🚨 WebSocket network error:", err.message);
        });
    }

    async syncWatchedWallets() {
        console.log("[PUMPPORTAL] 🔍 Syncing watched wallets from database...");
        const wallets = await WatchedWallet.find({ isActive: true });
        if (wallets.length > 0) {
            const keys = wallets.map(w => w.walletAddress);
            this.ws.send(JSON.stringify({
                method: "subscribeAccountTrade",
                keys
            }));
            console.log(`[PUMPPORTAL] ✅ Subscribed to trades for ${keys.length} watched wallets.`);
        } else {
            console.log("[PUMPPORTAL] ℹ️ No watched wallets found in DB.");
        }
    }

    async syncActiveTrades() {
        console.log("[PUMPPORTAL] 🔍 Syncing active trades for TP/SL monitoring...");
        const activeTrades = await ActiveTrade.find({ status: { $in: ["OPEN", "REENTERED"] } });
        if (activeTrades.length > 0) {
            const keys = activeTrades.map(t => t.mint);
            this.ws.send(JSON.stringify({
                method: "subscribeTokenTrade",
                keys
            }));
            console.log(`[PUMPPORTAL] ✅ Subscribed to ${keys.length} active trade tokens for live Market Cap tracking.`);
        } else {
            console.log("[PUMPPORTAL] ℹ️ No active trades found for monitoring.");
        }
    }
    
    // Add wallet to stream dynamically
    watchWallet(walletAddress) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log(`[PUMPPORTAL] ➕ Dynamically adding wallet to live stream: ${walletAddress}`);
            this.ws.send(JSON.stringify({
                method: "subscribeAccountTrade",
                keys: [walletAddress]
            }));
        }
    }
    
    // Add token to stream dynamically
    watchToken(mint) {
         if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log(`[PUMPPORTAL] ➕ Dynamically tracking token for TP/SL: ${mint}`);
            this.ws.send(JSON.stringify({
                method: "subscribeTokenTrade",
                keys: [mint]
            }));
        }
    }

    async handleMessage(msg) {
        if (msg.txType === "create") {
            console.log(`[PUMPPORTAL] 🪙 New token created: ${msg.mint} (Initial MC: ${msg.marketCapSol || 0} SOL)`);
            await tradeEngine.handleNewToken(msg);
        } else if (msg.txType === "buy" || msg.txType === "sell") {
            // It could be a trade from a watched account, OR a trade on a watched token
            await tradeEngine.handleTradeEvent(msg);
        }
    }
}

module.exports = new PumpPortalService();
