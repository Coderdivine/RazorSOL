const { Telegraf, Markup } = require('telegraf');
const { PublicKey } = require('@solana/web3.js');
const WatchedWallet = require('../models/WatchedWallet');
const ActiveTrade = require('../models/ActiveTrade');
const TokenMetrics = require('../models/TokenMetrics');
const solanaService = require('./solana.service');
const { TELEGRAM_BOT_TOKEN, WALLET_PUBLIC_KEY, TELEGRAM_ALERTS_CHANNEL } = process.env;

function isValidSolanaAddress(addr) {
    if (!addr || typeof addr !== 'string') return false;
    const trimmed = addr.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return false;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return false;
    try {
        const pk = new PublicKey(trimmed);
        return PublicKey.isOnCurve(pk.toBuffer());
    } catch {
        return false;
    }
}

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

        // Centralized error handler to prevent transient network errors from crashing the process
        this.bot.catch((err, ctx) => {
            console.warn(`[TELEGRAM] ⚠️ Handled Telegraf network/API error for ${ctx?.updateType || 'operation'}:`, err.message);
        });

        this.registerCommands();
        this.registerHears();
        this.registerInlineQuery();
        this.registerActions();
        this.registerTextHandler();

        // Register Telegram Command Auto-Suggestions across all scopes (shown as user types '/')
        try {
            const commands = [
                { command: 'start', description: '⚡ Open Main Trading Terminal & Controls' },
                { command: 'positions', description: '💼 View Open Positions & Trade History' },
                { command: 'stats', description: '📊 Real-time PnL & Performance Terminal' },
                { command: 'profile', description: '🤖 Bot Profile, Strategy & Live Status' },
                { command: 'earlyca', description: '⚙️ Toggle Early CA Discovery: /earlyca [on|off]' },
                { command: 'threshold', description: '🎯 Set Watchlist Threshold: /threshold <amount>' },
                { command: 'address', description: '💳 Bot Trading Wallet Address & Balance' },
                { command: 'wallet', description: '💳 View Bot Trading Wallet (Alias)' },
                { command: 'list', description: '👁️ Active Monitored Whale Wallets' },
                { command: 'watch', description: '🎯 Mirror a Whale: /watch <address>' },
                { command: 'remove', description: '🗑️ Untrack a Whale: /remove <address>' },
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

        // Resilient bot launcher with automatic reconnection on 409 conflict or network dropout
        const launchBot = async (retryCount = 0) => {
            try {
                // Clear any lingering webhook or stale polling lock
                await this.bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
                await this.bot.launch();
                console.log("[TELEGRAM] 🚀 Telegraf polling engine active and listening.");
            } catch (err) {
                console.error(`[TELEGRAM] ❌ Bot launch error (attempt ${retryCount + 1}):`, err.message);
                const delay = Math.min(25000, 3000 * Math.pow(1.5, retryCount));
                console.log(`[TELEGRAM] 🔄 Auto-reconnecting bot in ${Math.round(delay / 1000)}s...`);
                setTimeout(() => launchBot(retryCount + 1), delay);
            }
        };

        launchBot();

        // Enable graceful stop
        process.once('SIGINT', () => this.bot && this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot && this.bot.stop('SIGTERM'));
    }

    getPersistentKeyboard() {
        return Markup.keyboard([
            ['📊 /stats', '💼 /positions'],
            ['🤖 /profile', '⚙️ /earlyca'],
            ['💳 /address', '📜 /list'],
            ['🎯 /watch', '📖 /help']
        ]).resize().persistent().placeholder('💡 Type / or tap a command below...');
    }

    getMenuButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('💼 Active Positions', 'action_positions'), Markup.button.callback('📊 Performance Terminal', 'action_stats')],
            [Markup.button.callback('🤖 Bot Profile', 'action_profile'), Markup.button.callback('⚙️ Early CA Discovery', 'action_earlyca_menu')],
            [Markup.button.callback('💳 Bot Address', 'action_address'), Markup.button.callback('📜 Monitored Wallets', 'action_list')],
            [Markup.button.callback('📖 Strategy Guide', 'action_help')]
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
            [Markup.button.callback('🎯 Copy Trading Engine', 'help_cat_copy'), Markup.button.callback('🔫 Milestone Sniper', 'help_cat_sniper')],
            [Markup.button.callback('🛡️ Risk & Anti-Rug Guard', 'help_cat_risk'), Markup.button.callback('💼 Wallet Management', 'help_cat_wallets')],
            [Markup.button.callback('⚙️ Early CA Settings', 'action_earlyca_menu'), Markup.button.callback('📊 Analytics Terminal', 'help_cat_stats')]
        ]);
    }

    getHelpBackButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Return to Strategy Guide', 'action_help'), Markup.button.callback('📊 View Terminal', 'action_stats')]
        ]);
    }

    registerCommands() {
        // Start Command
        this.bot.start(async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /start command from user: ${ctx.chat.id}`);
            const msg = `⚡ *RAZOR SOLANA TRADING TERMINAL*\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `Institutional-grade copy-trading, 5K milestone sniping, and autonomous bonding curve execution.\n\n` +
                        `• *Engine Status:* 🟢 Active 24/7\n` +
                        `• *Trading Wallet:* \`${WALLET_PUBLIC_KEY}\`\n\n` +
                        `💡 *Quick Suggestion Bar:* Commands are now available in your keyboard below and auto-suggest as you type \`/\`.`;
            
            // Attach persistent reply keyboard so placeholder and instant buttons are pinned
            await ctx.reply(msg, { parse_mode: 'Markdown', ...this.getPersistentKeyboard() }).catch(e => console.warn("[TELEGRAM] Start reply error:", e.message));
            
            // Send inline action dashboard
            await ctx.reply(`Select an operation to execute:`, this.getMenuButtons()).catch(() => {});
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

        // Positions Command (with /trades alias)
        this.bot.command(['positions', 'trades', 'orders'], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /positions command from user: ${ctx.chat.id}`);
            await this.handlePositions(ctx);
        });

        // Watch Command
        this.bot.command('watch', async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /watch command from user: ${ctx.chat.id}`);
            const text = ctx.message.text;
            const parts = text.split(' ').filter(p => p.trim().length > 0);
            
            if (parts.length < 2) {
                return ctx.reply(
                    `🎯 *HOW TO WATCH A WHALE WALLET*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `Track any whale wallet to mirror their trades in real-time.\n\n` +
                    `*Usage:*\n\`/watch <wallet_address>\`\n\n` +
                    `*Example:*\n\`/watch AH39BneW9UeWxQysUcwogQrYFdPvJuRVZ5w4ccq9SKfL\`\n\n` +
                    `💡 *Pro-Tip:* You can also simply *paste* any Solana wallet address directly into this chat!`,
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            }
            
            const wallet = parts[1].trim();
            if (!isValidSolanaAddress(wallet)) {
                return ctx.reply(`❌ *Invalid Solana Address:*\n\`${wallet}\`\nPlease provide a valid 32-44 character base58 public key.`, { parse_mode: 'Markdown' }).catch(() => {});
            }

            await this.addWalletToWatch(ctx, wallet);
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
            const parts = text.split(' ').filter(p => p.trim().length > 0);
            
            if (parts.length < 2) {
                return this.handleListWallets(ctx);
            }
            const wallet = parts[1].trim();
            await this.removeWalletFromWatch(ctx, wallet);
        });

        // Early CA Command (with /sniper alias)
        this.bot.command(['earlyca', 'sniper'], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /earlyca command from user: ${ctx.chat.id}`);
            await this.handleEarlyCACommand(ctx);
        });

        // Threshold Command
        this.bot.command(['threshold', 'setthreshold'], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /threshold command from user: ${ctx.chat.id}`);
            await this.handleThresholdCommand(ctx);
        });

        // Set Group Command (dynamically sets/links the alert channel)
        this.bot.command(['setgroup', 'alertgroup', 'channel'], async (ctx) => {
            const chatId = ctx.chat.id.toString();
            this.configuredAlertChannel = chatId;
            process.env.TELEGRAM_ALERTS_CHANNEL = chatId;
            console.log(`[TELEGRAM] ✅ Alert group dynamically registered: ${chatId} (${ctx.chat.title || 'Direct/Group'})`);
            ctx.reply(
                `🔔 *Razor Alert Channel Connected!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `This chat has been set as the primary alert channel.\n\n` +
                `• *Chat ID:* \`${chatId}\`\n` +
                `• *Destination:* ${ctx.chat.title || 'Direct Alerts'}\n\n` +
                `_Whale buys, whale sells, and Razor bot trades will now be posted here in real-time._`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        });
    }

    registerHears() {
        // Handle persistent reply keyboard taps and natural language typed commands
        this.bot.hears([/^\s*📊\s*(\/)?stats/i, /^\s*stats\b/i, /^\s*pnl\b/i, /^\s*chart\b/i], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Route: stats from user: ${ctx.chat.id}`);
            await this.handleStats(ctx, '1d');
        });

        this.bot.hears([/^\s*💼\s*(\/)?position(s)?/i, /^\s*position(s)?\b/i, /^\s*trades?\b/i, /^\s*orders?\b/i], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Route: positions from user: ${ctx.chat.id}`);
            await this.handlePositions(ctx);
        });

        this.bot.hears([/^\s*🤖\s*(\/)?profile/i, /^\s*profile(s)?\b/i, /^\s*status\b/i, /^\s*config\b/i], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Route: profile from user: ${ctx.chat.id}`);
            await this.handleBotProfile(ctx);
        });

        this.bot.hears([/^\s*⚙️\s*(\/)?earlyca/i, /^\s*earlyca\b/i, /^\s*sniper\b/i], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Route: earlyca from user: ${ctx.chat.id}`);
            await this.handleEarlyCACommand(ctx);
        });

        this.bot.hears([/^\s*💳\s*(\/)?address/i, /^\s*address\b/i, /^\s*wallet\b/i, /^\s*balance\b/i, /^\s*sol\b/i], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Route: address from user: ${ctx.chat.id}`);
            await this.handleBotAddress(ctx);
        });

        this.bot.hears([/^\s*📜\s*(\/)?list/i, /^\s*list\b/i, /^\s*wallets\b/i, /^\s*tracked\b/i], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Route: list from user: ${ctx.chat.id}`);
            await this.handleListWallets(ctx);
        });

        this.bot.hears([/^\s*📖\s*(\/)?help/i, /^\s*help\b/i, /^\s*guide\b/i, /^\s*strategy\b/i], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Route: help from user: ${ctx.chat.id}`);
            this.sendHelpMessage(ctx);
        });

        this.bot.hears([/^\s*🎯\s*(\/)?watch/i], async (ctx) => {
            console.log(`[TELEGRAM] 📥 Route: watch guide from user: ${ctx.chat.id}`);
            const text = 
`🎯 *COPY-TRADE WHALE WALLET*
━━━━━━━━━━━━━━━━━━━━━━
To track a whale and mirror trades proportionally, send:
\`/watch <wallet_address>\`

*Example:*
\`/watch AH39BneW9UeWxQysUcwogQrYFdPvJuRVZ5w4ccq9SKfL\`

💡 *Pro-Tip:* You can also simply *paste* any Solana wallet address directly into this chat! Razor will detect it automatically.`;
            ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
        });
    }

    registerInlineQuery() {
        // Enables interactive command suggestions right above typing bar when user types @RazorSOLbot
        this.bot.on('inline_query', async (ctx) => {
            const query = (ctx.inlineQuery?.query || '').trim().toLowerCase();
            const results = [
                {
                    type: 'article',
                    id: 'cmd_stats',
                    title: '📊 /stats — Performance Terminal',
                    description: 'View real-time PnL, win rate, and chart',
                    input_message_content: { message_text: '/stats' }
                },
                {
                    type: 'article',
                    id: 'cmd_profile',
                    title: '🤖 /profile — Bot Profile & Status',
                    description: 'View risk caps, sniper parameters, and engine uptime',
                    input_message_content: { message_text: '/profile' }
                },
                {
                    type: 'article',
                    id: 'cmd_earlyca',
                    title: '⚙️ /earlyca — Early CA Discovery Toggle',
                    description: 'Toggle automatic new token discovery (on/off)',
                    input_message_content: { message_text: '/earlyca' }
                },
                {
                    type: 'article',
                    id: 'cmd_threshold',
                    title: '🎯 /threshold — Set Watchlist Gate',
                    description: 'Set minimum MC threshold (e.g. /threshold 10000)',
                    input_message_content: { message_text: '/threshold 10000' }
                },
                {
                    type: 'article',
                    id: 'cmd_address',
                    title: '💳 /address — Bot Trading Wallet',
                    description: 'View trading wallet address and live SOL balance',
                    input_message_content: { message_text: '/address' }
                },
                {
                    type: 'article',
                    id: 'cmd_list',
                    title: '📜 /list — Monitored Wallets',
                    description: 'View all active whale wallets currently tracked',
                    input_message_content: { message_text: '/list' }
                },
                {
                    type: 'article',
                    id: 'cmd_help',
                    title: '📖 /help — Strategy & Architecture Guide',
                    description: 'Interactive breakdown of 10K gate, milestone sniping, and risk rules',
                    input_message_content: { message_text: '/help' }
                }
            ];

            const filtered = query
                ? results.filter(r => r.title.toLowerCase().includes(query) || r.description.toLowerCase().includes(query) || r.id.toLowerCase().includes(query))
                : results;

            await ctx.answerInlineQuery(filtered, { cache_time: 10 }).catch(() => {});
        });
    }

    registerTextHandler() {
        // Fallback text router: detects pasted Solana addresses or gives smart suggestions for unknown input
        this.bot.on('text', async (ctx) => {
            const text = ctx.message.text.trim();

            // Check if user pasted a Solana address directly
            if (isValidSolanaAddress(text)) {
                return this.handleDetectedWallet(ctx, text);
            }

            // If user typed an unrecognized message, suggest commands with 1-tap buttons
            const suggestMsg =
`💡 *Razor Command Assistant*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
I didn't recognize that command. Here are quick shortcuts you can use:

• \`/stats\` — 📊 View live PnL, win rate & chart
• \`/profile\` — 🤖 View bot strategy & live status
• \`/earlyca [on|off]\` — ⚙️ Toggle new token discovery
• \`/threshold <amount>\` — 🎯 Set watchlist Market Cap gate (e.g. 10000)
• \`/address\` — 💳 View bot trading wallet & balance
• \`/list\` — 📜 View active monitored whale wallets
• \`/watch <address>\` — 🎯 Mirror a whale wallet
• \`/remove <address>\` — 🗑️ Untrack a whale wallet
• \`/help\` — 📖 Strategy documentation & controls

_Tap any button below or use the pinned menu at the bottom:_`;

            await ctx.reply(suggestMsg, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('📊 /stats', 'action_stats'), Markup.button.callback('🤖 /profile', 'action_profile')],
                    [Markup.button.callback('⚙️ /earlyca', 'action_earlyca_menu'), Markup.button.callback('💳 /address', 'action_address')],
                    [Markup.button.callback('📜 /list', 'action_list'), Markup.button.callback('📖 /help', 'action_help')]
                ]).reply_markup
            }).catch(() => {});
        });
    }

    async handleDetectedWallet(ctx, wallet) {
        if (WALLET_PUBLIC_KEY && wallet.toLowerCase() === WALLET_PUBLIC_KEY.toLowerCase()) {
            return ctx.reply(
                `💡 That is *Razor's own trading wallet*!\n\nTo view its balance and explorer details, run \`/address\`.`,
                { parse_mode: 'Markdown' }
            );
        }

        const existing = await WatchedWallet.findOne({ walletAddress: wallet });
        if (existing) {
            return ctx.reply(
                `👁️ *Monitored Whale Address Detected*\n\`${wallet}\`\n\nThis whale is already in your active monitor list.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🗑️ Untrack Wallet', `unwatch:${wallet}`)],
                        [Markup.button.url('🔎 View on Solscan', `https://solscan.io/account/${wallet}`)]
                    ]).reply_markup
                }
            );
        }

        return ctx.reply(
            `🎯 *Solana Wallet Address Detected:*\n\`${wallet}\`\n\nWould you like Razor to monitor and mirror this whale's trades?`,
            {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('➕ Start Copy-Trading', `watch:${wallet}`)],
                    [Markup.button.url('🔎 View on Solscan', `https://solscan.io/account/${wallet}`)]
                ]).reply_markup
            }
        );
    }

    async addWalletToWatch(ctx, wallet) {
        try {
            const existing = await WatchedWallet.findOne({ walletAddress: wallet });
            if (existing) {
                return ctx.reply(`⚠️ Wallet \`${wallet}\` is already in your active watch list.`, { parse_mode: 'Markdown' }).catch(() => {});
            }

            await WatchedWallet.create({
                walletAddress: wallet,
                addedBy: ctx.chat?.id?.toString() || 'unknown'
            });

            // Dynamically subscribe on both PumpPortal and Solana RPC
            const wsService = require('./pumpportal.service');
            wsService.watchWallet(wallet);

            console.log(`[TELEGRAM] ✅ Successfully added wallet to watch list: ${wallet}`);
            const msg = `🎯 *Target Whale Added to Dual-Engine Monitor:*\n\`${wallet}\`\n\n_Razor will mirror buys proportionally in real-time._`;
            
            const buttons = Markup.inlineKeyboard([
                [Markup.button.callback('📜 View Monitored Wallets', 'action_list'), Markup.button.callback('📊 Performance Terminal', 'action_stats')],
                [Markup.button.url('🔎 View on Solscan', `https://solscan.io/account/${wallet}`)]
            ]);

            if (ctx.callbackQuery) {
                await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...buttons }).catch(() => {
                    ctx.reply(msg, { parse_mode: 'Markdown', ...buttons }).catch(() => {});
                });
            } else {
                ctx.reply(msg, { parse_mode: 'Markdown', ...buttons }).catch(() => {});
            }
        } catch (err) {
            console.error(`[TELEGRAM] ❌ Error adding wallet:`, err.message);
            ctx.reply(`❌ Error adding wallet: ${err.message}`).catch(() => {});
        }
    }

    async removeWalletFromWatch(ctx, wallet) {
        try {
            const result = await WatchedWallet.deleteOne({ walletAddress: wallet });
            if (result.deletedCount > 0) {
                console.log(`[TELEGRAM] 🗑️ Removed wallet from watch list: ${wallet}`);
                const msg = `🗑️ *Untracked Wallet:*\n\`${wallet}\`\n\n_Removed from real-time monitoring and copy-trading._`;
                if (ctx.callbackQuery) {
                    await ctx.editMessageText(msg, { parse_mode: 'Markdown' }).catch(() => {
                        ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => {});
                    });
                } else {
                    ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => {});
                }
            } else {
                ctx.reply(`⚠️ Wallet not found in active watch list.`).catch(() => {});
            }
        } catch (err) {
            console.error(`[TELEGRAM] ❌ Error removing wallet:`, err.message);
            ctx.reply(`❌ Error removing wallet: ${err.message}`).catch(() => {});
        }
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

        this.bot.action('action_positions', async (ctx) => {
            await ctx.answerCbQuery('Loading positions...').catch(() => {});
            await this.handlePositions(ctx);
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

        this.bot.action('action_earlyca_menu', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            await this.showEarlyCAStatus(ctx);
        });

        this.bot.action('action_toggle_earlyca_on', async (ctx) => {
            const tradeEngine = require('./trade-engine.service');
            await tradeEngine.setEarlyCADiscovery(true);
            await ctx.answerCbQuery('Early CA Discovery Enabled!').catch(() => {});
            await this.showEarlyCAStatus(ctx);
        });

        this.bot.action('action_toggle_earlyca_off', async (ctx) => {
            const tradeEngine = require('./trade-engine.service');
            await tradeEngine.setEarlyCADiscovery(false);
            await ctx.answerCbQuery('Early CA Discovery Paused.').catch(() => {});
            await this.showEarlyCAStatus(ctx);
        });

        // Dynamic One-Tap Watch & Unwatch callback actions
        this.bot.action(/^watch:(.+)$/, async (ctx) => {
            const wallet = ctx.match[1];
            await ctx.answerCbQuery('Adding to monitor...').catch(() => {});
            await this.addWalletToWatch(ctx, wallet);
        });

        this.bot.action(/^unwatch:(.+)$/, async (ctx) => {
            const wallet = ctx.match[1];
            await ctx.answerCbQuery('Removing from monitor...').catch(() => {});
            await this.removeWalletFromWatch(ctx, wallet);
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
            const tradeEngine = require('./trade-engine.service');
            const threshK = Math.round(tradeEngine.watchlistThresholdUSD / 1000);
            const isEnabled = tradeEngine.earlyCADiscoveryEnabled;
            const text = `🔫 *MILESTONE SNIPER STRATEGY*\n` +
                         `━━━━━━━━━━━━━━━━━━━━━━\n` +
                         `• *${threshK}K Market Cap Gate:* Newly launched meme tokens start around ~$4.5k. Razor only saves tokens that successfully cross *$${tradeEngine.watchlistThresholdUSD.toLocaleString()} USD Market Cap* to avoid zero-volume rugs.\n` +
                         `• *Early CA Control:* Currently ${isEnabled ? '🟢 ACTIVE' : '🔴 PAUSED'}. Easily toggle using \`/earlyca on\` or \`/earlyca off\`.\n` +
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

    async handlePositions(ctx) {
        try {
            const [openTrades, recentClosed] = await Promise.all([
                ActiveTrade.find({ status: { $in: ['OPEN', 'REENTERED', 'TP_TAKEN_WAITING_REENTRY'] } }).sort({ createdAt: -1 }),
                ActiveTrade.find({ status: 'CLOSED' }).sort({ updatedAt: -1 }).limit(5)
            ]);

            let text = `💼 *RAZOR ACTIVE POSITIONS & TRADES*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

            if (openTrades.length === 0) {
                text += `🟢 *Active Positions:* None currently open.\n\n` +
                        `_Razor enters trades automatically when monitored whales buy or tokens hit 5K milestone progression ($10k ➔ $20k ➔ $50k)._\n\n`;
            } else {
                text += `🟢 *Active Open Positions (${openTrades.length}):*\n`;
                openTrades.forEach((t, i) => {
                    const shortMint = `${t.mint.substring(0, 6)}...${t.mint.substring(t.mint.length - 6)}`;
                    const statusBadge = t.status === 'REENTERED' ? '🔄 Re-entered (Dip)' : (t.status === 'TP_TAKEN_WAITING_REENTRY' ? '⏳ TP Taken • Watching Dip' : '⚡ Open');
                    text += `${i + 1}. *${t.tokenName || 'Token'}* (\`${shortMint}\`)\n` +
                            `   • *Status:* ${statusBadge}\n` +
                            `   • *Invested:* \`${t.amountSolInvested?.toFixed(4) || '0'} SOL\`\n` +
                            `   • *Source:* ${t.source === 'COPY_TRADE' ? '🎯 Whale Mirror' : '🔫 5K Milestone Snipe'}\n` +
                            `   • *Links:* [Pump.fun](https://pump.fun/${t.mint}) | [Solscan](https://solscan.io/token/${t.mint})\n\n`;
                });
            }

            if (recentClosed.length > 0) {
                text += `🏁 *Recently Settled Trades (${recentClosed.length}):*\n`;
                recentClosed.forEach((t, i) => {
                    const shortMint = `${t.mint.substring(0, 4)}...${t.mint.substring(t.mint.length - 4)}`;
                    text += `${i + 1}. [\`${shortMint}\`](https://pump.fun/${t.mint}) • \`${t.amountSolInvested?.toFixed(4) || '0'} SOL\` • ${t.source}\n`;
                });
                text += `\n`;
            }

            text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

            const buttons = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh Positions', 'action_positions'), Markup.button.callback('📊 Performance Terminal', 'action_stats')],
                [Markup.button.callback('🤖 Bot Profile', 'action_profile'), Markup.button.callback('💳 Bot Address', 'action_address')]
            ]);

            if (ctx.callbackQuery && !ctx.callbackQuery.message?.photo) {
                await ctx.editMessageText(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(async () => {
                    await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(() => {});
                });
            } else {
                await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...buttons }).catch(() => {});
            }
        } catch (err) {
            console.error("[TELEGRAM] ❌ Error in handlePositions:", err.message);
            ctx.reply("❌ Error fetching active positions.").catch(() => {});
        }
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

    async handleEarlyCACommand(ctx) {
        const text = (ctx.message?.text || '').trim();
        const parts = text.split(/\s+/);
        const sub = parts[1]?.toLowerCase();
        const tradeEngine = require('./trade-engine.service');

        if (sub === 'on' || sub === 'enable' || sub === '1' || sub === 'true') {
            await tradeEngine.setEarlyCADiscovery(true);
            const msg = `🟢 *Early CA Discovery is now ENABLED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `• Razor is actively listening to newly launched tokens.\n` +
                        `• Watchlist Gate Threshold: *$${tradeEngine.watchlistThresholdUSD.toLocaleString()} USD*\n\n` +
                        `_Tokens reaching $${Math.round(tradeEngine.watchlistThresholdUSD / 1000)}k MC will be saved to your DB watchlist and tracked for 10k ➔ 20k ➔ 50k milestone snipes._`;
            return ctx.reply(msg, { parse_mode: 'Markdown', ...this.getEarlyCAButtons(true) }).catch(() => {});
        } else if (sub === 'off' || sub === 'disable' || sub === '0' || sub === 'false') {
            await tradeEngine.setEarlyCADiscovery(false);
            const msg = `🔴 *Early CA Discovery is now DISABLED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `• Razor has paused listening to newly launched tokens.\n` +
                        `• *Copy-trading remains 100% active* on your watched whale wallets.\n` +
                        `• No untargeted token alerts or spam will be processed.\n\n` +
                        `_You can re-enable anytime using_ \`/earlyca on\` _or the button below._`;
            return ctx.reply(msg, { parse_mode: 'Markdown', ...this.getEarlyCAButtons(false) }).catch(() => {});
        }

        // No param provided: show current status with 1-tap toggle buttons
        await this.showEarlyCAStatus(ctx);
    }

    async showEarlyCAStatus(ctx) {
        const tradeEngine = require('./trade-engine.service');
        const isEnabled = tradeEngine.earlyCADiscoveryEnabled;
        const statusBadge = isEnabled ? '🟢 ACTIVE (Listening to New Launches)' : '🔴 PAUSED (Zero Token Spam)';
        const threshold = tradeEngine.watchlistThresholdUSD;

        const text =
`⚙️ *EARLY CA DISCOVERY & WATCHLIST GATE*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• *Status:* ${statusBadge}
• *Watchlist Gate:* \`$${threshold.toLocaleString()} USD\`
• *Milestone Sniper Progression:* \`$10k ➔ $20k ➔ $50k\`
• *Whale Copy-Trading:* 🟢 Always Active

💡 *Description:*
When enabled, Razor listens to PumpPortal for newly created tokens and tracks their market cap. Tokens reaching *$${Math.round(threshold / 1000)}k MC* are registered to your permanent DB watchlist.

When disabled, Razor ignores untargeted token launches, conserving bandwidth and eliminating spam notifications while *still mirroring all watched whale wallets*.

*Commands:*
• \`/earlyca on\` — Enable early token discovery
• \`/earlyca off\` — Pause early token discovery
• \`/threshold <amount>\` — Set watchlist gate (current: $${threshold.toLocaleString()})`;

        const buttons = this.getEarlyCAButtons(isEnabled);
        if (ctx.callbackQuery && !ctx.callbackQuery.message?.photo) {
            await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons }).catch(async () => {
                await ctx.reply(text, { parse_mode: 'Markdown', ...buttons }).catch(() => {});
            });
        } else {
            await ctx.reply(text, { parse_mode: 'Markdown', ...buttons }).catch(() => {});
        }
    }

    getEarlyCAButtons(isEnabled) {
        const toggleBtn = isEnabled
            ? Markup.button.callback('🔴 Turn OFF Early CA', 'action_toggle_earlyca_off')
            : Markup.button.callback('🟢 Turn ON Early CA', 'action_toggle_earlyca_on');

        return Markup.inlineKeyboard([
            [toggleBtn],
            [Markup.button.callback('🤖 Bot Profile', 'action_profile'), Markup.button.callback('📊 Performance Terminal', 'action_stats')]
        ]);
    }

    async handleThresholdCommand(ctx) {
        const text = (ctx.message?.text || '').trim();
        const parts = text.split(/\s+/);
        const tradeEngine = require('./trade-engine.service');

        if (parts.length < 2) {
            return ctx.reply(
                `🎯 *WATCHLIST MARKET CAP THRESHOLD*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Current Watchlist Gate: *$${tradeEngine.watchlistThresholdUSD.toLocaleString()} USD*\n\n` +
                `*Usage:*\n\`/threshold <amount_usd>\`\n\n` +
                `*Example:*\n\`/threshold 10000\` (sets gate to $10k)\n\`/threshold 15000\` (sets gate to $15k)`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        const amount = parseFloat(parts[1].replace(/[^0-9.]/g, ''));
        if (isNaN(amount) || amount < 1000) {
            return ctx.reply(`❌ *Invalid Amount:* Please specify a minimum threshold of $1,000 USD (e.g. \`/threshold 10000\`).`, { parse_mode: 'Markdown' }).catch(() => {});
        }

        try {
            await tradeEngine.setWatchlistThreshold(amount);
            const msg = `✅ *Watchlist Gate Updated!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `New Gate Threshold: *$${amount.toLocaleString()} USD*\n\n` +
                        `_Only tokens reaching at least $${amount.toLocaleString()} MC will be saved to your permanent DB watchlist._`;
            ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (err) {
            ctx.reply(`❌ Error setting threshold: ${err.message}`).catch(() => {});
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

            const tradeEngine = require('./trade-engine.service');
            const earlyCAStatus = tradeEngine.earlyCADiscoveryEnabled ? '🟢 Enabled' : '🔴 Disabled (Zero Spam)';
            const watchlistGate = `$${tradeEngine.watchlistThresholdUSD.toLocaleString()} USD`;

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
• *Early CA Discovery:* \`${earlyCAStatus}\`
• *Watchlist Gate:* \`> ${watchlistGate}\` Market Cap
• *Snipe Progression:* \`$10k ➔ $20k ➔ $50k\` MC
• *Take Profit (TP):* \`2.0x (+100%)\` + \`50%\` Dip Re-entry
• *Stop Loss (SL):* \`1.2x (-16.7%)\` Hard Protection
• *DB Auto-Cleanup:* \`90 Days\` (3-Month TTL)

📊 *Live State Summary:*
• *Monitored Whales:* \`${watchedCount}\`
• *Watchlist Coins:* \`${trackedTokensCount}\`
• *Active Positions:* \`${openTradesCount}\` | *Settled:* \`${closedTradesCount}\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

            const buttons = Markup.inlineKeyboard([
                [Markup.button.callback('⚙️ Early CA Toggle', 'action_earlyca_menu'), Markup.button.callback('💳 Bot Address', 'action_address')],
                [Markup.button.callback('📜 Monitored Wallets', 'action_list'), Markup.button.callback('📊 Performance Chart', 'action_stats')],
                [Markup.button.callback('🔄 Refresh Profile', 'action_profile')]
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
                // Upload image directly via native Node fetch + FormData (ultra-fast & 100% reliable)
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
            return ctx.reply(
                `👁️ *Monitored Whales:* None active.\n\nTo begin tracking, use: \`/watch <wallet_address>\` or paste an address below.`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
        
        let response = `👁️ *ACTIVE MONITORED WHALES (${wallets.length})*\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        wallets.forEach((w, i) => {
            const short = `${w.walletAddress.substring(0, 6)}...${w.walletAddress.substring(w.walletAddress.length - 6)}`;
            response += `${i + 1}. [\`${short}\`](https://solscan.io/account/${w.walletAddress})\n   \`${w.walletAddress}\`\n\n`;
        });
        
        response += `_Tap a button below to remove, or use \`/remove <address>\`_`;

        // Generate quick action buttons for monitored wallets
        const inlineRows = wallets.map(w => {
            const short = `${w.walletAddress.substring(0, 4)}...${w.walletAddress.substring(w.walletAddress.length - 4)}`;
            return [
                Markup.button.callback(`🗑️ Untrack ${short}`, `unwatch:${w.walletAddress}`),
                Markup.button.url(`🔎 Solscan`, `https://solscan.io/account/${w.walletAddress}`)
            ];
        });

        inlineRows.push([
            Markup.button.callback('📊 Performance Terminal', 'action_stats'),
            Markup.button.callback('🤖 Bot Profile', 'action_profile')
        ]);

        ctx.reply(response, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: Markup.inlineKeyboard(inlineRows).reply_markup
        }).catch(() => {});
    }

    async sendAlert(message) {
        if (!this.bot) return;

        // Gather all target recipients
        const targets = new Set();
        if (this.configuredAlertChannel) targets.add(this.configuredAlertChannel);
        if (process.env.TELEGRAM_ALERTS_CHANNEL) targets.add(process.env.TELEGRAM_ALERTS_CHANNEL);

        // Also broadcast to users who registered watched wallets in DB
        try {
            const wallets = await WatchedWallet.find({ isActive: true });
            wallets.forEach(w => {
                if (w.addedBy && w.addedBy !== 'unknown' && w.addedBy !== 'inline') {
                    targets.add(w.addedBy);
                }
            });
        } catch {}

        if (targets.size === 0) {
            console.log("[TELEGRAM] ⚠️ No active alert channels or subscribers configured.");
            return;
        }

        console.log(`[TELEGRAM] 📤 Dispatching alert to ${targets.size} recipient(s): [${[...targets].join(', ')}]`);

        for (const targetId of targets) {
            try {
                await this.bot.telegram.sendMessage(targetId, message, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: false
                });
            } catch (err) {
                // If markdown parse failed, try sending plain text
                if (err.message.includes("can't parse entities") || err.message.includes('find end of the entity')) {
                    try {
                        const plainText = message.replace(/[*_`\[\]()]/g, '');
                        await this.bot.telegram.sendMessage(targetId, plainText);
                    } catch {}
                } else {
                    console.warn(`[TELEGRAM] ⚠️ Alert dispatch notice for ${targetId}:`, err.message);
                }
            }
        }
    }
}

module.exports = new TelegramService();
