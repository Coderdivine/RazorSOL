const TelegramBot = require('node-telegram-bot-api');
const WatchedWallet = require('../models/WatchedWallet');
const { TELEGRAM_BOT_TOKEN } = process.env;

class TelegramService {
    constructor() {
        this.bot = null;
    }

    init() {
        if (!TELEGRAM_BOT_TOKEN) {
            console.log("<::: No Telegram Bot Token found. Telegram controller disabled.");
            return;
        }

        this.bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
        console.log(":::> Telegram Bot Controller started.");

        this.registerCommands();
    }

    registerCommands() {
        // Start Command
        this.bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            this.bot.sendMessage(chatId, `Welcome to Razor Trading Bot 🗡️\nCommands:\n/watch <wallet_address>\n/list\n/remove <wallet_address>\n/simulate`);
        });

        // Watch Command
        this.bot.onText(/\/watch (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const wallet = match[1];

            try {
                const existing = await WatchedWallet.findOne({ walletAddress: wallet });
                if (existing) {
                    return this.bot.sendMessage(chatId, `Wallet ${wallet} is already being watched.`);
                }

                await WatchedWallet.create({
                    walletAddress: wallet,
                    addedBy: chatId.toString()
                });

                // Dynamically subscribe in websocket
                const wsService = require('./pumpportal.service');
                wsService.watchWallet(wallet);

                this.bot.sendMessage(chatId, `✅ Successfully watching wallet for copy trades:\n${wallet}`);
            } catch (err) {
                this.bot.sendMessage(chatId, `❌ Error adding wallet: ${err.message}`);
            }
        });

        // List Command
        this.bot.onText(/\/list/, async (msg) => {
            const chatId = msg.chat.id;
            const wallets = await WatchedWallet.find({ isActive: true });
            if (wallets.length === 0) {
                return this.bot.sendMessage(chatId, `No wallets are currently being watched.`);
            }
            
            let response = `👁️ **Watched Wallets:**\n\n`;
            wallets.forEach((w, i) => {
                response += `${i + 1}. ${w.walletAddress}\n`;
            });
            
            this.bot.sendMessage(chatId, response, { parse_mode: "Markdown" });
        });

        // Remove Command
        this.bot.onText(/\/remove (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const wallet = match[1];

            const result = await WatchedWallet.deleteOne({ walletAddress: wallet });
            if (result.deletedCount > 0) {
                this.bot.sendMessage(chatId, `🗑️ Removed wallet from watch list:\n${wallet}`);
            } else {
                this.bot.sendMessage(chatId, `Wallet not found in watch list.`);
            }
        });
        
        // Simulate Command
        this.bot.onText(/\/simulate/, (msg) => {
            const chatId = msg.chat.id;
            const simulationText = `
🧪 **Profit vs Gas Simulation (20 Trades)**

**$10 Base Size (Total $200):**
- PumpPortal Fees (0.5% in/out): ~$20.00
- Sniper Gas Fees: ~$14.00
- Net Profit required to breakeven: ~17% per trade.
- *Verdict: Sniper mode cuts heavily into $10 margins. Best to use 100% TP at 2x.*

**$100 Base Size (Total $2000):**
- PumpPortal Fees: ~$200.00
- Sniper Gas Fees: ~$14.00
- Net Profit required to breakeven: ~10% per trade.
- *Verdict: 70/30 TP strategy recommended to leave moonbags.*
            `;
            this.bot.sendMessage(chatId, simulationText, { parse_mode: "Markdown" });
        });
    }
}

module.exports = new TelegramService();
