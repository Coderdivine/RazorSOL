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
        const uri = `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`;
        this.ws = new WebSocket(uri);

        this.ws.on('open', async () => {
            console.log(":::> Connected to PumpPortal Websocket");
            this.reconnectAttempts = 0;
            
            // Subscribe to new tokens
            this.ws.send(JSON.stringify({ method: "subscribeNewToken" }));
            
            // Sync watched wallets
            await this.syncWatchedWallets();

            // Sync active trade tokens to watch their MC for TP/SL
            await this.syncActiveTrades();

            // Keep connection alive
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.ping();
                }
            }, 30000);
        });

        this.ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                await this.handleMessage(message);
            } catch (err) {
                console.error("<::: Error parsing WS message", err);
            }
        });

        this.ws.on('close', () => {
            console.log("<::: PumpPortal Websocket closed. Reconnecting...");
            clearInterval(this.pingInterval);
            setTimeout(() => this.connect(), Math.min(10000, 1000 * Math.pow(2, this.reconnectAttempts++)));
        });

        this.ws.on('error', (err) => {
            console.error("<::: PumpPortal Websocket error:", err);
        });
    }

    async syncWatchedWallets() {
        const wallets = await WatchedWallet.find({ isActive: true });
        if (wallets.length > 0) {
            const keys = wallets.map(w => w.walletAddress);
            this.ws.send(JSON.stringify({
                method: "subscribeAccountTrade",
                keys
            }));
            console.log(`:::> Subscribed to ${keys.length} watched wallets`);
        }
    }

    async syncActiveTrades() {
        const activeTrades = await ActiveTrade.find({ status: { $in: ["OPEN", "REENTERED"] } });
        if (activeTrades.length > 0) {
            const keys = activeTrades.map(t => t.mint);
            this.ws.send(JSON.stringify({
                method: "subscribeTokenTrade",
                keys
            }));
            console.log(`:::> Subscribed to ${keys.length} active trade tokens for TP/SL monitoring`);
        }
    }
    
    // Add wallet to stream dynamically
    watchWallet(walletAddress) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                method: "subscribeAccountTrade",
                keys: [walletAddress]
            }));
        }
    }
    
    // Add token to stream dynamically
    watchToken(mint) {
         if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                method: "subscribeTokenTrade",
                keys: [mint]
            }));
        }
    }

    async handleMessage(msg) {
        // Log to see the structure of events
        // console.log("Incoming Message:", msg);

        if (msg.txType === "create") {
            // New Token Created
            await tradeEngine.handleNewToken(msg);
        } else if (msg.txType === "buy" || msg.txType === "sell") {
            // It could be a trade from a watched account, OR a trade on a watched token
            // We pass it to the engine to evaluate
            await tradeEngine.handleTradeEvent(msg);
        }
    }
}

module.exports = new PumpPortalService();
