const { Telegraf, Markup } = require('telegraf');
const WatchedWallet = require('../models/WatchedWallet');
const ActiveTrade = require('../models/ActiveTrade');
const TokenMetrics = require('../models/TokenMetrics');
const solanaService = require('./solana.service');
const { TELEGRAM_BOT_TOKEN, WALLET_PUBLIC_KEY, TELEGRAM_ALERTS_CHANNEL } = process.env;

class TelegramService {
    constructor() {
        this.bot = null;
        this.startedAt = new Date();
    }

    async init() {
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

        // Register Telegram Command Auto-Suggestions across all scopes (shown as user types '/')
        try {
            const commands = [
                { command: 'profile', description: '🤖 View Bot Profile, Strategy & Live Status' },
                { command: 'address', description: '💳 View Bot Trading Wallet Address & Balance' },
                { command: 'stats', description: '📊 Real-time PnL & Performance Terminal' },
                { command: 'list', description: '👁️ View Active Monitored Whale Wallets' },
                { command: 'watch', description: '🎯 Mirror a Whale: /watch <address>' },
                { command: 'remove', description: '🗑️ Stop Monitoring: /remove <address>' },
                { command: 'help', description: '📖 Interactive Strategy & Control Guide' }
            ];

            await this.bot.telegram.setMyCommands(commands, { scope: { type: 'default' } });
            await this.bot.telegram.setMyCommands(commands, { scope: { type: 'all_private_chats' } });
            await this.bot.telegram.setMyCommands(commands, { scope: { type: 'all_group_chats' } });
            await this.bot.telegram.setChatMenuButton({ menu_button: { type: 'commands' } });
            console.log("[TELEGRAM] ✅ Command auto-suggestions and menu button registered across all scopes.");
        } catch (e) {
            console.warn("[TELEGRAM] ⚠️ Failed to register commands with Telegram:", e.message);
        }
        
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
            [Markup.button.callback('🤖 Bot Profile', 'action_profile'), Markup.button.callback('💳 Bot Address', 'action_address')],
            [Markup.button.callback('📜 Monitored Wallets', 'action_list'), Markup.button.callback('📊 Performance Terminal', 'action_stats')],
            [Markup.button.callback('📖 Strategy & Architecture Guide', 'action_help')]
        ]);
    }

    getStatsButtons(currentTimeframe = '1d') {
        const btn1d = currentTimeframe === '1d' ? '• 24H •' : '24H';
        const btn1w = currentTimeframe === '1w' ? '• 7D •' : '7D';
        const btn1m = currentTimeframe === '1m' ? '• 30D •' : '30D';
        return Markup.inlineKeyboard([
            [
                Markup.button.callback(btn1d, 'action_stats_1d'),
                Markup.button.callback(btn1w, 'action_stats_1w'),
                Markup.button.callback(btn1m, 'action_stats_1m')
            ],
            [
                Markup.button.callback('🔄 Refresh Data', `action_stats_${currentTimeframe}`),
                Markup.button.callback('🤖 Bot Profile', 'action_profile')
            ]
        ]);
    }

    getHelpCategoryButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('🤖 Bot Profile', 'action_profile'), Markup.button.callback('💳 Bot Address', 'action_address')],
            [Markup.button.callback('🎯 Copy Trading Engine', 'help_cat_copy'), Markup.button.callback('🔫 5K Milestone Sniper', 'help_cat_sniper')],
            [Markup.button.callback('🛡️ Risk & Anti-Rug Guard', 'help_cat_risk'), Markup.button.callback('💼 Wallet Management', 'help_cat_wallets')],
            [Markup.button.callback('📊 Analytics Terminal', 'help_cat_stats'), Markup.button.callback('⚡ Main Dashboard', 'action_stats')]
        ]);
    }

    registerCommands() {
        // Start Command
        this.bot.start((ctx) => {
            console.log(`[TELEGRAM] 📥 Received /start command from user: ${ctx.chat.id}`);
            const msg = `⚡ *RAZOR SOLANA TRADING TERMINAL*\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `Institutional-grade copy-trading, 5K milestone sniping, and autonomous bonding curve execution.\n\n` +
                        `• *Engine Status:* 🟢 Active 24/7\n` +
                        `• *Trading Wallet:* \`${WALLET_PUBLIC_KEY}\`\n\n` +
                        `Select an option below or type \`/\` to see available commands:`;
            ctx.reply(msg, { parse_mode: 'Markdown', ...this.getMenuButtons() }).catch(e => console.warn("[TELEGRAM] Start reply error:", e.message));
        });

        // Address Command (with /wallet alias)
        this.bot.command(['address', 'wallet'], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /address command from user: ${ctx.chat.id}`);
            await this.handleBotAddress(ctx);
        });

        // Profile Command (with /profiles alias)
        this.bot.command(['profile', 'profiles'], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /profile command from user: ${ctx.chat.id}`);
            await this.handleBotProfile(ctx);
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
            
            const wallet = parts[1].trim();

            try {
                const existing = await WatchedWallet.findOne({ walletAddress: wallet });
                if (existing) {
                    return ctx.reply(`⚠️ Wallet \`${wallet}\` is already in your active watch list.`, { parse_mode: 'Markdown' }).catch(() => {});
                }

                await WatchedWallet.create({
                    walletAddress: wallet,
                    addedBy: ctx.chat.id.toString()
                });

                // Dynamically subscribe on both PumpPortal and Solana RPC
                const wsService = require('./pumpportal.service');
                wsService.watchWallet(wallet);

                console.log(`[TELEGRAM] ✅ Successfully added wallet to watch list: ${wallet}`);
                ctx.reply(`🎯 *Target Wallet Added to Dual-Engine Monitor:*\n\`${wallet}\`\n\n_Razor will mirror buys proportionally in real-time._`, { parse_mode: 'Markdown' }).catch(() => {});
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
            
            const wallet = parts[1].trim();
            const result = await WatchedWallet.deleteOne({ walletAddress: wallet });
            
            if (result.deletedCount > 0) {
                console.log(`[TELEGRAM] 🗑️ Removed wallet from watch list: ${wallet}`);
                ctx.reply(`🗑️ Untracked wallet:\n\`${wallet}\``, { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                ctx.reply(`⚠️ Wallet not found in active watch list.`).catch(() => {});
            }
        });
    }

    registerActions() {
        this.bot.action('action_address', async (ctx) => {
            await ctx.answerCbQuery('Fetching wallet details...').catch(() => {});
            await this.handleBotAddress(ctx);
        });

        this.bot.action('action_profile', async (ctx) => {
            await ctx.answerCbQuery('Loading bot profile...').catch(() => {});
            await this.handleBotProfile(ctx);
        });

        this.bot.action('action_list', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            await this.handleListWallets(ctx);
        });

        this.bot.action('action_help', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            this.sendHelpMessage(ctx);
        });

        this.bot.action('action_stats', async (ctx) => {
            await ctx.answerCbQuery('Fetching live terminal metrics...').catch(() => {});
            this.handleStats(ctx, '1d');
        });

        this.bot.action('action_stats_1d', async (ctx) => {
            await ctx.answerCbQuery('Loading 24H Window...').catch(() => {});
            this.handleStats(ctx, '1d');
        });

        this.bot.action('action_stats_1w', async (ctx) => {
            await ctx.answerCbQuery('Loading 7D Window...').catch(() => {});
            this.handleStats(ctx, '1w');
        });

        this.bot.action('action_stats_1m', async (ctx) => {
            await ctx.answerCbQuery('Loading 30D Window...').catch(() => {});
            this.handleStats(ctx, '1m');
        });

        // Help Categories
        this.bot.action('help_cat_copy', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text = `🎯 *COPY TRADING ENGINE*\n` +
                         `━━━━━━━━━━━━━━━━━━━━━━\n` +
                         `Razor monitors your target whale addresses using a *Dual-Engine* stream (PumpPortal WebSocket + Solana RPC On-Chain Logs).\n\n` +
                         `• *Gain Factor Math:* When a target wallet buys, Razor compares their spent SOL to their total liquid SOL balance to determine their conviction scale.\n` +
                         `• *Scale Allocation:* Razor mirrors that exact percentage against your own balance.\n` +
                         `• *Circuit Breakers:* Max allocation is capped at 10% of portfolio per trade. Min trade size is 0.01 SOL.\n` +
                         `• *Instant Alerts:* Every buy sends a rich notification to your private alert group.`;
            ctx.editMessageText(text, { parse_mode: 'Markdown', ...this.getHelpBackButtons() }).catch(() => {});
        });

        this.bot.action('help_cat_sniper', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text = `🔫 *5K MILESTONE SNIPER STRATEGY*\n` +
                         `━━━━━━━━━━━━━━━━━━━━━━\n` +
                         `• *5K Market Cap Gate:* Newly launched meme tokens start around ~$4.5k. Razor only saves tokens that successfully cross *$5,000 USD Market Cap* to avoid zero-volume rugs.\n` +
                         `• *Milestone Progression:* If a token crosses 10k and 20k MC consecutively, momentum probability spikes. Razor snipes the coin targeting the 50k progression.\n` +
                         `• *In-Memory Caching:* Token evaluation runs in RAM memory to execute sub-millisecond entry before bonding curve surges.`;
            ctx.editMessageText(text, { parse_mode: 'Markdown', ...this.getHelpBackButtons() }).catch(() => {});
        });

        this.bot.action('help_cat_risk', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text = `🛡️ *RISK MANAGEMENT & ANTI-RUG GUARD*\n` +
                         `━━━━━━━━━━━━━━━━━━━━━━\n` +
                         `• *Take Profit (2x):* The default rule is to sell 100% position upon achieving a 2x gain.\n` +
                         `• *Smart Re-entry:* After locking 2x profit, Razor watches for a dip back to the initial entry Market Cap and re-enters with 50% capital.\n` +
                         `• *Stop Loss (1.2x):* If a position depreciates by 20% (1.2x drop from entry), Razor exits immediately to preserve capital.\n` +
                         `• *3-Month TTL Auto-Purge:* Dead coins are automatically deleted from MongoDB after 90 days.`;
            ctx.editMessageText(text, { parse_mode: 'Markdown', ...this.getHelpBackButtons() }).catch(() => {});
        });

        this.bot.action('help_cat_wallets', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text = `💼 *WALLET MANAGEMENT COMMANDS*\n` +
                         `━━━━━━━━━━━━━━━━━━━━━━\n` +
                         `• \`/address\` — View bot trading wallet address & live SOL balance.\n` +
                         `• \`/profile\` — View bot trading profile, strategy parameters & status.\n` +
                         `• \`/watch <address>\` — Begin tracking and copy-trading a whale.\n` +
                         `• \`/remove <address>\` — Stop monitoring and delete from database.\n` +
                         `• \`/list\` — View all currently active monitored addresses.\n\n` +
                         `💡 _Tip: You can add or remove wallets on the fly without restarting the bot._`;
            ctx.editMessageText(text, { parse_mode: 'Markdown', ...this.getHelpBackButtons() }).catch(() => {});
        });

        this.bot.action('help_cat_stats', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text = `📊 *PERFORMANCE TERMINAL*\n` +
                         `━━━━━━━━━━━━━━━━━━━━━━\n` +
                         `• \`/stats\` — Renders real-time PnL metrics and high-resolution chart.\n` +
                         `• *Timeframes:* Toggle between 24 Hours, 7 Days, and 30 Days.\n` +
                         `• *Offline Engine:* Charts are generated locally as native high-resolution images in 20ms without relying on external image servers.`;
            ctx.editMessageText(text, { parse_mode: 'Markdown', ...this.getHelpBackButtons() }).catch(() => {});
        });
    }

    getHelpBackButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Return to Strategy Guide', 'action_help'), Markup.button.callback('📊 View Terminal', 'action_stats')]
        ]);
    }

    async handleBotAddress(ctx) {
        try {
            const walletAddress = WALLET_PUBLIC_KEY || 'Not Configured';
            const solBalance = WALLET_PUBLIC_KEY ? await solanaService.getSolBalance(WALLET_PUBLIC_KEY) : 0;
            const solPrice = solanaService.getSolPriceUSD();
            const usdBalance = (solBalance * solPrice).toFixed(2);
            const streamStatus = solBalance >= 0.02
                ? '🟢 Metered Stream Active (≥ 0.02 SOL)'
                : '🟡 On-Chain RPC Mode (Fund ≥ 0.02 SOL for PumpPortal WSS)';

            const text =
`💳 *RAZOR BOT TRADING WALLET*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏷️ *Public Key (Tap to Copy):*
\`${walletAddress}\`

💰 *Live Balance:*
• *SOL:* \`${solBalance.toFixed(4)} SOL\` (~$${usdBalance} USD)
• *SOL Price:* \`$${solPrice.toFixed(2)}\`
• *Stream Tier:* ${streamStatus}

🔗 *Explorer:* [View on Solscan](https://solscan.io/account/${walletAddress})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Send SOL to the address above to fund autonomous copy-trading and milestone snipes._`;

            const buttons = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh Balance', 'action_address'), Markup.button.callback('🤖 Bot Profile', 'action_profile')],
                [Markup.button.url('🔎 Open on Solscan', `https://solscan.io/account/${walletAddress}`)]
            ]);

            if (ctx.callbackQuery && !ctx.callbackQuery.message?.photo) {
                await ctx.editMessageText(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(async () => {
                    await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(() => {});
                });
            } else {
                await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(() => {});
            }
        } catch (err) {
            console.error("[TELEGRAM] ❌ Error in handleBotAddress:", err.message);
            ctx.reply("❌ Error fetching bot wallet address.").catch(() => {});
        }
    }

    async handleBotProfile(ctx) {
        try {
            const walletAddress = WALLET_PUBLIC_KEY || 'Not Configured';
            const shortWallet = walletAddress.length > 10
                ? `${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 6)}`
                : walletAddress;

            const [solBalance, watchedCount, trackedTokensCount, openTradesCount, closedTradesCount] = await Promise.all([
                WALLET_PUBLIC_KEY ? solanaService.getSolBalance(WALLET_PUBLIC_KEY) : 0,
                WatchedWallet.countDocuments({ isActive: true }).catch(() => 0),
                TokenMetrics.countDocuments({}).catch(() => 0),
                ActiveTrade.countDocuments({ status: { $in: ['OPEN', 'REENTERED', 'TP_TAKEN_WAITING_REENTRY'] } }).catch(() => 0),
                ActiveTrade.countDocuments({ status: 'CLOSED' }).catch(() => 0)
            ]);

            const solPrice = solanaService.getSolPriceUSD();
            const usdBalance = (solBalance * solPrice).toFixed(2);

            const uptimeMs = Date.now() - this.startedAt.getTime();
            const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
            const mins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
            const uptimeStr = `${hours}h ${mins}m`;

            const text =
`🤖 *RAZOR BOT PROFILE & CONFIGURATION*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ *System Identity:*
• *Bot Name:* RazorSOL Autonomous Engine
• *Status:* 🟢 Online 24/7 (Uptime: \`${uptimeStr}\`)
• *Data Feeds:* Dual-Engine (PumpPortal WSS + Solana RPC)
• *Alert Channel:* \`${TELEGRAM_ALERTS_CHANNEL || 'Not Set'}\`

💳 *Trading Vault:*
• *Address:* [\`${shortWallet}\`](https://solscan.io/account/${walletAddress})
• *Full Key:* \`${walletAddress}\`
• *Liquid Balance:* \`${solBalance.toFixed(4)} SOL\` (~$${usdBalance})

🎯 *Copy-Trading Profile:*
• *Sizing Model:* Proportional Whale Gain Factor
• *Max Risk Cap:* \`10%\` of Portfolio per Trade
• *Min Order Size:* \`0.01 SOL\` (Fallback: \`5%\`)
• *Slippage / Priority:* \`15%\` Slippage • Local Signing

🔫 *Sniper & Risk Profile:*
• *Watchlist Gate:* \`> $5,000 USD\` Market Cap
• *Snipe Progression:* \`$10k ➔ $20k ➔ $50k\` MC
• *Take Profit (TP):* \`2.0x (+100%)\` + \`50%\` Dip Re-entry
• *Stop Loss (SL):* \`1.2x (-16.7%)\` Hard Protection
• *DB Auto-Cleanup:* \`90 Days\` (3-Month TTL)

📊 *Live State Summary:*
• *Monitored Whales:* \`${watchedCount}\`
• *5K+ Watchlist Coins:* \`${trackedTokensCount}\`
• *Active Positions:* \`${openTradesCount}\` | *Settled:* \`${closedTradesCount}\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

            const buttons = Markup.inlineKeyboard([
                [Markup.button.callback('💳 Bot Address', 'action_address'), Markup.button.callback('📊 Performance Chart', 'action_stats')],
                [Markup.button.callback('📜 Monitored Wallets', 'action_list'), Markup.button.callback('🔄 Refresh Profile', 'action_profile')]
            ]);

            if (ctx.callbackQuery && !ctx.callbackQuery.message?.photo) {
                await ctx.editMessageText(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(async () => {
                    await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(() => {});
                });
            } else {
                await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(() => {});
            }
        } catch (err) {
            console.error("[TELEGRAM] ❌ Error in handleBotProfile:", err.message);
            ctx.reply("❌ Error loading bot profile.").catch(() => {});
        }
    }

    async handleStats(ctx, timeframe = '1d') {
        const statsService = require('./stats.service');
        const stats = await statsService.getStats(timeframe);
        const solPrice = solanaService.getSolPriceUSD();
        const pnlUsd = (stats.totalPnlSol * solPrice).toFixed(2);
        const pnlPrefix = stats.totalPnlSol >= 0 ? '+' : '';

        const caption = 
`⚡ *RAZOR PROTOCOL • PERFORMANCE TERMINAL*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏱️ *Window:* ${stats.timeframeLabel} • Solana Mainnet

📊 *PnL Metrics:*
• Net PnL: \`${pnlPrefix}${stats.totalPnlSol.toFixed(4)} SOL\` (~$${pnlUsd})
• Win Rate: \`${stats.winRate}%\` (${stats.closedCount} Settled)
• Open Positions: \`${stats.openCount} Active\`

🎯 *Network Status:*
• Monitored Whales: \`${stats.totalWatched} Wallets\`
• Total Logged Trades: \`${stats.totalTrades}\`
• SOL Price: \`$${solPrice.toFixed(2)}\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        const keyboard = this.getStatsButtons(timeframe);
        const chatId = ctx.chat?.id || ctx.message?.chat?.id || ctx.callbackQuery?.message?.chat?.id;

        if (stats.chartBuffer && chatId) {
            try {
                // Upload image directly via native Node 26 fetch + FormData (ultra-fast & 100% reliable)
                const blob = new Blob([stats.chartBuffer], { type: 'image/png' });
                const form = new FormData();
                form.append('chat_id', chatId.toString());
                form.append('photo', blob, 'performance_chart.png');
                form.append('caption', caption);
                form.append('parse_mode', 'Markdown');
                form.append('reply_markup', JSON.stringify(keyboard.reply_markup));

                const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
                    method: 'POST',
                    body: form
                });
                const data = await res.json();
                if (data.ok) return;
            } catch (uploadErr) {
                console.warn("[TELEGRAM] ⚠️ Native photo upload error:", uploadErr.message);
            }
        }

        // Clean text fallback
        ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
    }

    sendHelpMessage(ctx) {
        const helpText = 
`⚡ *RAZOR ARCHITECTURE & CONTROL GUIDE*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Welcome to the Razor autonomous trading engine. Select any module below for in-depth documentation on algorithms and controls:`;

        if (ctx.callbackQuery && !ctx.callbackQuery.message?.photo) {
            ctx.editMessageText(helpText, { parse_mode: 'Markdown', ...this.getHelpCategoryButtons() }).catch(() => {
                ctx.reply(helpText, { parse_mode: 'Markdown', ...this.getHelpCategoryButtons() }).catch(() => {});
            });
        } else {
            ctx.reply(helpText, { parse_mode: 'Markdown', ...this.getHelpCategoryButtons() }).catch(() => {});
        }
    }

    async handleListWallets(ctx) {
        const wallets = await WatchedWallet.find({ isActive: true });
        if (wallets.length === 0) {
            return ctx.reply(`👁️ *Monitored Whales:* None active.\n\nTo begin tracking, use: \`/watch <wallet_address>\``, { parse_mode: 'Markdown' }).catch(() => {});
        }
        
        let response = `👁️ *ACTIVE MONITORED WHALES (${wallets.length})*\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        wallets.forEach((w, i) => {
            const short = `${w.walletAddress.substring(0, 6)}...${w.walletAddress.substring(w.walletAddress.length - 6)}`;
            response += `${i + 1}. [\`${short}\`](https://solscan.io/account/${w.walletAddress})\n   \`${w.walletAddress}\`\n\n`;
        });
        
        response += `To remove a wallet: \`/remove <wallet_address>\``;
        ctx.reply(response, { parse_mode: 'Markdown' }).catch(() => {});
    }

    sendAlert(message) {
        if (!this.bot) return;
        const channelId = process.env.TELEGRAM_ALERTS_CHANNEL;
        if (channelId) {
            console.log(`[TELEGRAM] 📤 Dispatching alert to channel (${channelId})`);
            this.bot.telegram.sendMessage(channelId, message, { parse_mode: 'Markdown' })
                .catch(err => console.error("[TELEGRAM] ❌ Alert Error:", err.message));
        }
    }
}

module.exports = new TelegramService();
