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

        // Centralized error handler to prevent transient network errors (ECONNRESET, ETIMEDOUT) from crashing the server
        this.bot.catch((err, ctx) => {
            console.warn(`[TELEGRAM] ⚠️ Handled Telegraf network/API error for ${ctx?.updateType || 'operation'}:`, err.message);
        });

        this.registerCommands();
        this.registerActions();
        
        // Launch the bot gracefully
        this.bot.launch().catch(err => {
            console.error("[TELEGRAM] ❌ Failed to launch bot:", err.message);
        });

        // Enable graceful stop
        process.once('SIGINT', () => this.bot && this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot && this.bot.stop('SIGTERM'));
    }

    getMenuButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('📜 List Watched Wallets', 'action_list'), Markup.button.callback('📊 View Stats', 'action_stats')],
            [Markup.button.callback('❓ Help & Instructions', 'action_help')]
        ]);
    }

    getStatsButtons(currentTimeframe = '1d') {
        const btn1d = currentTimeframe === '1d' ? '• 1D •' : '1D';
        const btn1w = currentTimeframe === '1w' ? '• 1W •' : '1W';
        const btn1m = currentTimeframe === '1m' ? '• 1M •' : '1M';
        return Markup.inlineKeyboard([
            [
                Markup.button.callback(btn1d, 'action_stats_1d'),
                Markup.button.callback(btn1w, 'action_stats_1w'),
                Markup.button.callback(btn1m, 'action_stats_1m')
            ],
            [Markup.button.callback('🔄 Refresh Stats', `action_stats_${currentTimeframe}`)]
        ]);
    }

    registerCommands() {
        // Start Command
        this.bot.start((ctx) => {
            console.log(`[TELEGRAM] 📥 Received /start command from user: ${ctx.chat.id}`);
            const msg = `Welcome to *Razor Trading Bot* 🗡️\n\nI am running 24/7 to monitor Solana meme tokens, auto-snipe tokens crossing milestone Market Caps, and mirror whale trades in real-time.\n\nUse the buttons below or type /help to get started.`;
            ctx.reply(msg, { parse_mode: 'Markdown', ...this.getMenuButtons() }).catch(e => console.warn("[TELEGRAM] Start reply error:", e.message));
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

        // Stats Command
        this.bot.command('stats', (ctx) => {
             console.log(`[TELEGRAM] 📥 Received /stats command from user: ${ctx.chat.id}`);
             this.handleStats(ctx, '1d');
        });

        // Watch Command
        this.bot.command('watch', async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /watch command from user: ${ctx.chat.id}`);
            const text = ctx.message.text;
            const parts = text.split(' ');
            
            if(parts.length < 2) {
                return ctx.reply('❌ Please provide a wallet address.\n*Usage:* `/watch <wallet_address>`', { parse_mode: 'Markdown' }).catch(() => {});
            }
            
            const wallet = parts[1];

            try {
                const existing = await WatchedWallet.findOne({ walletAddress: wallet });
                if (existing) {
                    return ctx.reply(`⚠️ Wallet \`${wallet}\` is already being watched.`, { parse_mode: 'Markdown' }).catch(() => {});
                }

                await WatchedWallet.create({
                    walletAddress: wallet,
                    addedBy: ctx.chat.id.toString()
                });

                // Dynamically subscribe in websocket
                const wsService = require('./pumpportal.service');
                wsService.watchWallet(wallet);

                console.log(`[TELEGRAM] ✅ Successfully added wallet to watch list: ${wallet}`);
                ctx.reply(`✅ *Successfully watching wallet for copy trades:*\n\`${wallet}\``, { parse_mode: 'Markdown' }).catch(() => {});
            } catch (err) {
                console.error(`[TELEGRAM] ❌ Error adding wallet:`, err.message);
                ctx.reply(`❌ Error adding wallet: ${err.message}`).catch(() => {});
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
                return ctx.reply('❌ Please provide a wallet address.\n*Usage:* `/remove <wallet_address>`', { parse_mode: 'Markdown' }).catch(() => {});
            }
            
            const wallet = parts[1];
            const result = await WatchedWallet.deleteOne({ walletAddress: wallet });
            
            if (result.deletedCount > 0) {
                console.log(`[TELEGRAM] 🗑️ Removed wallet from watch list: ${wallet}`);
                ctx.reply(`🗑️ Removed wallet from watch list:\n\`${wallet}\``, { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                ctx.reply(`⚠️ Wallet not found in watch list.`).catch(() => {});
            }
        });
    }

    registerActions() {
        this.bot.action('action_list', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_list`);
            await ctx.answerCbQuery().catch(() => {});
            await this.handleListWallets(ctx);
        });

        this.bot.action('action_help', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_help`);
            await ctx.answerCbQuery().catch(() => {});
            this.sendHelpMessage(ctx);
        });

        this.bot.action('action_stats', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_stats`);
            await ctx.answerCbQuery().catch(() => {});
            this.handleStats(ctx, '1d');
        });

        this.bot.action('action_stats_1d', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_stats_1d`);
            await ctx.answerCbQuery('Loading 1D stats...').catch(() => {});
            this.handleStats(ctx, '1d');
        });

        this.bot.action('action_stats_1w', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_stats_1w`);
            await ctx.answerCbQuery('Loading 1W stats...').catch(() => {});
            this.handleStats(ctx, '1w');
        });

        this.bot.action('action_stats_1m', async (ctx) => {
            console.log(`[TELEGRAM] 🔘 Inline button clicked: action_stats_1m`);
            await ctx.answerCbQuery('Loading 1M stats...').catch(() => {});
            this.handleStats(ctx, '1m');
        });
    }

    async handleStats(ctx, timeframe = '1d') {
        try {
            const statsService = require('./stats.service');
            const stats = await statsService.getStats(timeframe);
            
            const caption = `📊 *Razor Bot Performance Analytics*\n` +
                            `⏱️ *Timeframe:* ${stats.timeframeLabel}\n\n` +
                            `👁️ *Watched Wallets:* ${stats.totalWatched}\n` +
                            `🔄 *Total Trades:* ${stats.totalTrades}\n` +
                            `🟢 *Open Trades:* ${stats.openCount}\n` +
                            `🔴 *Closed Trades:* ${stats.closedCount}\n` +
                            `💰 *Estimated PnL:* ${stats.totalPnlSol.toFixed(4)} SOL\n\n` +
                            `_Generated performance chart below:_`;
                            
            const keyboard = this.getStatsButtons(timeframe);
            const photoInput = stats.chartBuffer ? { source: stats.chartBuffer } : { url: stats.chartUrl };

            // If triggered by an inline button on an existing photo message, edit in-place
            if (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.photo) {
                try {
                    await ctx.editMessageMedia(
                        {
                            type: 'photo',
                            media: photoInput,
                            caption,
                            parse_mode: 'Markdown'
                        },
                        keyboard
                    );
                    return;
                } catch (editErr) {
                    console.warn("[TELEGRAM] ⚠️ editMessageMedia failed, falling back to new photo:", editErr.message);
                }
            }

            try {
                await ctx.replyWithPhoto(photoInput, { caption, parse_mode: 'Markdown', ...keyboard });
            } catch (photoErr) {
                console.warn("[TELEGRAM] ⚠️ replyWithPhoto failed, falling back to text reply:", photoErr.message);
                await ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard }).catch(e => {
                    console.warn("[TELEGRAM] ⚠️ Fallback text reply error:", e.message);
                });
            }
        } catch (err) {
            console.error("[TELEGRAM] ❌ Error generating stats:", err.message);
            ctx.reply("❌ Error retrieving analytics data.").catch(() => {});
        }
    }

    sendHelpMessage(ctx) {
        const helpText = `
*Razor Bot Help & Commands* 📖

Here is a detailed breakdown of all available commands:

🔸 \`/watch <wallet_address>\`
Adds a target whale wallet to the active monitor list. When this wallet buys a token on PumpPortal, Razor calculates its **Gain Factor** and mirrors the trade proportionately!

🔸 \`/remove <wallet_address>\`
Stops monitoring a specific wallet and removes it from the database.

🔸 \`/list\`
Displays all the wallets you are currently tracking.

🔸 \`/stats\`
Displays real-time performance analytics (Total Trades, Open/Closed positions, PnL) along with a generated visual performance chart across 1D, 1W, and 1M timeframes.

*Sniper & Anti-Rug Strategy:*
• **Auto-Watch Threshold:** Only new tokens reaching >$5k Market Cap are added to permanent watchlist.
• **Milestone Snipe:** Automatically snipes tokens breaking the 10k -> 20k -> 50k progression.
• **Stop Loss:** Sells instantly if the coin drops 20% (1.2x).
• **Take Profit:** Automatically sells at 2x to secure your capital.
        `;
        ctx.reply(helpText, { parse_mode: 'Markdown', ...this.getMenuButtons() }).catch(e => console.warn("[TELEGRAM] Help reply error:", e.message));
    }

    async handleListWallets(ctx) {
        const wallets = await WatchedWallet.find({ isActive: true });
        if (wallets.length === 0) {
            return ctx.reply(`No wallets are currently being watched.`).catch(() => {});
        }
        
        let response = `👁️ *Watched Wallets:*\n\n`;
        wallets.forEach((w, i) => {
            response += `${i + 1}. \`${w.walletAddress}\`\n`;
        });
        
        response += `\nTo remove one, type \`/remove <wallet_address>\``;
        ctx.reply(response, { parse_mode: 'Markdown' }).catch(() => {});
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
