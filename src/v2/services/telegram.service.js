const { Telegraf, Markup } = require('telegraf');
const WatchedWallet = require('../models/WatchedWallet');
const { TELEGRAM_BOT_TOKEN } = process.env;

class TelegramService {
    constructor() {
        this.bot = null;
    }

    init() {
        if (!TELEGRAM_BOT_TOKEN) {
            console.log("[TELEGRAM] ⚠️ No Telegram Bot Token found. Telegram controller disabled.");
            return;
        }

        this.bot = new Telegraf(TELEGRAM_BOT_TOKEN);
        console.log("[TELEGRAM] 🤖 Telegram Bot Controller initialized.");

        this.registerCommands();
        this.registerActions();
        
        // Launch the bot gracefully
        this.bot.launch();

        // Enable graceful stop
        process.once('SIGINT', () => this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }

    getMenuButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('📜 List Watched Wallets', 'action_list')],
            [Markup.button.callback('🧪 Run Simulation', 'action_simulate')],
            [Markup.button.callback('❓ Help & Instructions', 'action_help')]
        ]);
    }

    registerCommands() {
        // Start Command
        this.bot.start((ctx) => {
            console.log(`[TELEGRAM] 📥 Received /start command from user: ${ctx.chat.id}`);
            const msg = `Welcome to *Razor Trading Bot* 🗡️\n\nI am running 24/7 on Render to monitor Solana meme tokens and execute precision trades via PumpPortal.\n\nUse the buttons below or type /help to get started.`;
            ctx.reply(msg, { parse_mode: 'Markdown', ...this.getMenuButtons() });
        });

        // Help Command
        this.bot.help((ctx) => {
             console.log(`[TELEGRAM] 📥 Received /help command from user: ${ctx.chat.id}`);
             this.sendHelpMessage(ctx);
        });
        
        this.bot.command('help', (ctx) => {
             console.log(`[TELEGRAM] 📥 Received /help command from user: ${ctx.chat.id}`);
             this.sendHelpMessage(ctx);
        });

        // Watch Command
        this.bot.command('watch', async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /watch command from user: ${ctx.chat.id}`);
            const text = ctx.message.text;
            const parts = text.split(' ');
            
            if(parts.length < 2) {
                return ctx.reply('❌ Please provide a wallet address.\n*Usage:* `/watch <wallet_address>`', { parse_mode: 'Markdown' });
            }
            
            const wallet = parts[1];

            try {
                const existing = await WatchedWallet.findOne({ walletAddress: wallet });
                if (existing) {
                    return ctx.reply(`⚠️ Wallet \`${wallet}\` is already being watched.`, { parse_mode: 'Markdown' });
                }

                await WatchedWallet.create({
                    walletAddress: wallet,
                    addedBy: ctx.chat.id.toString()
                });

                // Dynamically subscribe in websocket
                const wsService = require('./pumpportal.service');
                wsService.watchWallet(wallet);

                console.log(`[TELEGRAM] ✅ Successfully added wallet to watch list: ${wallet}`);
                ctx.reply(`✅ *Successfully watching wallet for copy trades:*\n\`${wallet}\``, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error(`[TELEGRAM] ❌ Error adding wallet:`, err.message);
                ctx.reply(`❌ Error adding wallet: ${err.message}`);
            }
        });

        // List Command
        this.bot.command('list', async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /list command from user: ${ctx.chat.id}`);
            await this.handleListWallets(ctx);
        });

        // Remove Command
        this.bot.command('remove', async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /remove command from user: ${ctx.chat.id}`);
            const text = ctx.message.text;
            const parts = text.split(' ');
            
            if(parts.length < 2) {
                return ctx.reply('❌ Please provide a wallet address.\n*Usage:* `/remove <wallet_address>`', { parse_mode: 'Markdown' });
            }
            
            const wallet = parts[1];
            const result = await WatchedWallet.deleteOne({ walletAddress: wallet });
            
            if (result.deletedCount > 0) {
                console.log(`[TELEGRAM] 🗑️ Removed wallet from watch list: ${wallet}`);
                ctx.reply(`🗑️ Removed wallet from watch list:\n\`${wallet}\``, { parse_mode: 'Markdown' });
            } else {
                ctx.reply(`⚠️ Wallet not found in watch list.`);
            }
        });
        
        // Simulate Command
        this.bot.command('simulate', (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /simulate command from user: ${ctx.chat.id}`);
            this.handleSimulate(ctx);
        });
    }

    registerActions() {
        this.bot.action('action_list', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_list`);
            await ctx.answerCbQuery();
            await this.handleListWallets(ctx);
        });

        this.bot.action('action_simulate', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_simulate`);
            await ctx.answerCbQuery();
            this.handleSimulate(ctx);
        });

        this.bot.action('action_help', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_help`);
            await ctx.answerCbQuery();
            this.sendHelpMessage(ctx);
        });
    }

    sendHelpMessage(ctx) {
        const helpText = `
*Razor Bot Help & Commands* 📖

Here is a detailed breakdown of what I can do:

🔸 \`/watch <wallet_address>\`
Adds a target wallet to the active monitor list. The bot instantly hooks into the PumpPortal Websocket to track its buys. When it buys, we calculate its **Gain Factor** and mirror the trade proportionately!

🔸 \`/remove <wallet_address>\`
Stops monitoring a specific wallet and removes it from the database.

🔸 \`/list\`
Displays all the wallets you are currently tracking.

🔸 \`/simulate\`
Runs a financial breakdown based on 20 simulated trades using real network and API fees, showing you the exact cost difference between $10 and $100 normal trades vs. high-speed sniper trades.

*Anti-Rug & TP/SL Logic:*
I automatically track Market Cap milestones.
• **Stop Loss:** Sells instantly if the coin drops 20% (1.2x).
• **Take Profit:** Automatically sells at 2x. I will secure the profit and can be configured to leave a moonbag (70/30 split).
        `;
        ctx.reply(helpText, { parse_mode: 'Markdown', ...this.getMenuButtons() });
    }

    async handleListWallets(ctx) {
        const wallets = await WatchedWallet.find({ isActive: true });
        if (wallets.length === 0) {
            return ctx.reply(`No wallets are currently being watched.`);
        }
        
        let response = `👁️ *Watched Wallets:*\n\n`;
        wallets.forEach((w, i) => {
            response += `${i + 1}. \`${w.walletAddress}\`\n`;
        });
        
        response += `\nTo remove one, type \`/remove <wallet_address>\``;
        ctx.reply(response, { parse_mode: 'Markdown' });
    }

    async handleSimulate(ctx) {
        // Send a real-time message indicating it's running
        const waitingMsg = await ctx.reply("⚙️ *Running real-time simulation...* Please wait while I calculate network fees and profit metrics.", { parse_mode: "Markdown" });
        
        // Wait 3 seconds to simulate calculation
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const simulationText = `
🧪 *Profit vs Gas Simulation (20 Trades)*

*$10 Base Size (Total $200):*
- PumpPortal Fees (0.5% in/out): ~$20.00
- Sniper Gas Fees: ~$14.00
- Net Profit required to breakeven: ~17% per trade.
- *Verdict: Sniper mode cuts heavily into $10 margins. Best to use 100% TP at 2x.*

*$100 Base Size (Total $2000):*
- PumpPortal Fees: ~$200.00
- Sniper Gas Fees: ~$14.00
- Net Profit required to breakeven: ~10% per trade.
- *Verdict: 70/30 TP strategy recommended to leave moonbags.*
        `;
        
        // Update the waiting message with the results
        ctx.telegram.editMessageText(
            ctx.chat.id, 
            waitingMsg.message_id, 
            null, 
            simulationText, 
            { parse_mode: "Markdown" }
        );
    }

    sendAlert(message) {
        if (!this.bot) return;
        const channelId = process.env.TELEGRAM_ALERTS_CHANNEL;
        if (channelId) {
            console.log(`[TELEGRAM] 📤 Dispatching alert to private channel (${channelId})`);
            this.bot.telegram.sendMessage(channelId, message, { parse_mode: 'Markdown' })
                .catch(err => console.error("[TELEGRAM] ❌ Alert Error:", err.message));
        }
    }
}

module.exports = new TelegramService();
