const { Telegraf, Markup } = require('telegraf');
const { PublicKey } = require('@solana/web3.js');
const WatchedWallet = require('../models/WatchedWallet');
const ActiveTrade = require('../models/ActiveTrade');
const TokenMetrics = require('../models/TokenMetrics');
const ChannelMember = require('../models/ChannelMember');
const BotSettings = require('../models/BotSettings');
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
        this.adminChatId = null;
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

        // Auto-capture admin chat ID from any direct interaction in private chat
        this.bot.use(async (ctx, next) => {
            if (ctx.chat?.type === 'private' && ctx.chat?.id) {
                const chatId = String(ctx.chat.id);
                if (this.adminChatId !== chatId) {
                    this.adminChatId = chatId;
                    BotSettings.findOneAndUpdate(
                        { key: 'global' },
                        { adminChatId: chatId },
                        { upsert: true }
                    ).catch(() => {});
                }
            }
            return next();
        });

        this.registerCommands();
        this.registerChannelManager();
        this.registerHears();
        this.registerInlineQuery();
        this.registerActions();
        this.registerTextHandler();
        this.startExpirationWorker();

        // Register Telegram Command Auto-Suggestions across all scopes (shown as user types '/')
        try {
            const commands = [
                { command: 'start', description: '⚡ Open Main Trading Terminal & Controls' },
                { command: 'demo', description: '🎟️ Generate 24h VIP Demo Pass: /demo @username' },
                { command: 'extend', description: '⏳ Extend Member Trial: /extend @username 24h' },
                { command: 'grant', description: '👑 Grant Paid VIP Access: /grant @username tier1 30d' },
                { command: 'revoke', description: '🚫 Revoke Member Access: /revoke @username' },
                { command: 'members', description: '👥 View Active Demo & VIP Members' },
                { command: 'setchannel', description: '⚙️ Bind VIP Channel: /setchannel <channel_id>' },
                { command: 'pricing', description: '💎 View VIP Plans & Pricing' },
                { command: 'positions', description: '💼 View Open Positions & Trade History' },
                { command: 'stats', description: '📊 Real-time PnL & Performance Terminal' },
                { command: 'profile', description: '🤖 Bot Profile, Strategy & Live Status' },
                { command: 'earlyca', description: '⚙️ Toggle Early CA Discovery: /earlyca [on|off]' },
                { command: 'threshold', description: '🎯 Set Watchlist Threshold: /threshold <amount>' },
                { command: 'address', description: '💳 Bot Trading Wallet Address & Balance' },
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
                await this.bot.launch({
                    allowedUpdates: ['message', 'callback_query', 'inline_query', 'chat_member', 'my_chat_member']
                });
                console.log("[TELEGRAM] 🚀 Telegraf polling engine active and listening with chat_member updates enabled.");
            } catch (err) {
                console.error(`[TELEGRAM] ❌ Bot launch error (attempt ${retryCount + 1}):`, err.message);
                try { this.bot.stop(); } catch {}
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
            [Markup.button.callback('🎟️ VIP & Demo Hub', 'help_cat_vip'), Markup.button.callback('📜 Monitored Whales', 'action_list')],
            [Markup.button.callback('🤖 Bot Profile', 'action_profile'), Markup.button.callback('⚙️ Early CA Discovery', 'action_earlyca_menu')],
            [Markup.button.callback('💳 Bot Address', 'action_address'), Markup.button.callback('📖 Command Directory', 'action_help')]
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
            [Markup.button.callback('🎟️ VIP & Demo Management', 'help_cat_vip')],
            [Markup.button.callback('🎯 Whale Tracking', 'help_cat_whales')],
            [Markup.button.callback('💼 Positions & Trading', 'help_cat_trading')],
            [Markup.button.callback('⚙️ Settings & Discovery', 'help_cat_settings')]
        ]);
    }

    getVipHelpButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('🎟️ /demo (Create Pass)', 'action_cmd_demo'), Markup.button.callback('⏳ /extend (Add Time)', 'action_cmd_extend')],
            [Markup.button.callback('👥 /members (View Active)', 'action_members'), Markup.button.callback('💎 /pricing (Plans)', 'action_pricing')],
            [Markup.button.callback('👑 /grant (Give VIP)', 'action_cmd_grant'), Markup.button.callback('🚫 /revoke (Kick User)', 'action_cmd_revoke')],
            [Markup.button.callback('⚙️ /setchannel (Link Group)', 'action_cmd_setchannel')],
            [Markup.button.callback('🔙 Back to Categories', 'action_help')]
        ]);
    }

    getWhalesHelpButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('📜 /list (Monitored Wallets)', 'action_list'), Markup.button.callback('💳 /address (Bot Wallet)', 'action_address')],
            [Markup.button.callback('🎯 /watch (Add Whale)', 'action_cmd_watch'), Markup.button.callback('🗑️ /remove (Untrack)', 'action_cmd_remove')],
            [Markup.button.callback('🔙 Back to Categories', 'action_help')]
        ]);
    }

    getTradingHelpButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('💼 /positions (Open Trades)', 'action_positions'), Markup.button.callback('📊 /stats (PnL Chart)', 'action_stats')],
            [Markup.button.callback('🤖 /profile (Engine Status)', 'action_profile')],
            [Markup.button.callback('🔙 Back to Categories', 'action_help')]
        ]);
    }

    getSettingsHelpButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('⚙️ /earlyca (View Discovery)', 'action_earlyca_menu'), Markup.button.callback('🎯 /threshold (Set MC Gate)', 'action_cmd_threshold')],
            [Markup.button.callback('🟢 Enable Early CA', 'action_toggle_earlyca_on'), Markup.button.callback('🔴 Disable Early CA', 'action_toggle_earlyca_off')],
            [Markup.button.callback('🔙 Back to Categories', 'action_help')]
        ]);
    }

    getHelpBackButtons() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Return to Categories', 'action_help'), Markup.button.callback('📊 View Terminal', 'action_stats')]
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

        // Categorized Help Menus
        this.bot.action('help_cat_vip', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`🎟️ *VIP CHANNEL & DEMO MANAGEMENT*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Manage your private signals channel, generate 24-hour trials for prospects, check active members, and review pricing.

*Tap any command button below to run it or view setup:*`;
            await this.safeEditOrReply(ctx, text, this.getVipHelpButtons());
        });

        this.bot.action('help_cat_whales', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`🎯 *WHALE TRACKING & MONITORS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Monitor high-conviction Solana whale wallets. Whenever they buy or sell, Razor detects it instantly and posts alerts.

*Tap any command button below to run it or view setup:*`;
            await this.safeEditOrReply(ctx, text, this.getWhalesHelpButtons());
        });

        this.bot.action('help_cat_trading', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`💼 *POSITIONS & PERFORMANCE TERMINAL*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Track open meme coin positions, automatic profit-taking (2x rules), stop-loss exits, and view the live PnL chart.

*Tap any command button below to execute:*`;
            await this.safeEditOrReply(ctx, text, this.getTradingHelpButtons());
        });

        this.bot.action('help_cat_settings', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const tradeEngine = require('./trade-engine.service');
            const isEnabled = tradeEngine.earlyCADiscoveryEnabled;
            const threshK = Math.round(tradeEngine.watchlistThresholdUSD / 1000);
            const text =
`⚙️ *SETTINGS & EARLY CA DISCOVERY*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Control automatic early token discovery (milestone sniper) and customize market cap thresholds to filter out zero-volume rugs.

• *Early Discovery:* ${isEnabled ? '🟢 ACTIVE' : '🔴 PAUSED'}
• *Watchlist Gate:* \`$${tradeEngine.watchlistThresholdUSD.toLocaleString()} USD\` (${threshK}K MC)

*Tap any command button below:*`;
            await this.safeEditOrReply(ctx, text, this.getSettingsHelpButtons());
        });

        // Command Button Actions (VIP)
        this.bot.action('action_members', async (ctx) => {
            await ctx.answerCbQuery('Loading members dashboard...').catch(() => {});
            await this.handleMembers(ctx);
        });

        this.bot.action('action_pricing', async (ctx) => {
            await ctx.answerCbQuery('Loading pricing plans...').catch(() => {});
            await this.handlePricing(ctx);
        });

        this.bot.action('action_cmd_demo', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`🎟️ *COMMAND: /demo*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generate a single-use private invite link for a prospective client.
The link automatically burns once they join, and a 24-hour countdown begins. When their time is up, the bot automatically kicks them.

*Usage:*
\`/demo @username [hours]\`

*Examples:*
• \`/demo @crypto_sam\` (24-Hour Free Pass)
• \`/demo @crypto_sam 48h\` (48-Hour Pass)
• \`/demo @crypto_sam 3d\` (3-Day Pass)

💡 _Tap any example above to copy it, replace the username, and send._`;
            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Back to VIP Menu', 'help_cat_vip'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);
            await this.safeEditOrReply(ctx, text, markup);
        });

        this.bot.action('action_cmd_extend', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`⏳ *COMMAND: /extend*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Add extra time to an existing demo member before or after their pass expires.

*Usage:*
\`/extend @username <duration>\`

*Examples:*
• \`/extend @crypto_sam 24h\` (+24 hours)
• \`/extend @crypto_sam 48h\` (+48 hours)
• \`/extend @crypto_sam 7d\` (+7 days)

💡 _Tap any example above to copy it, replace the username, and send._`;
            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Back to VIP Menu', 'help_cat_vip'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);
            await this.safeEditOrReply(ctx, text, markup);
        });

        this.bot.action('action_cmd_grant', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`👑 *COMMAND: /grant*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Grant paid VIP subscription access to a member who sent payment.

*Usage:*
\`/grant @username <tier> <duration>\`

*Examples:*
• \`/grant @crypto_sam tier1 30d\` (Tier 1 Signals — 30 Days)
• \`/grant @crypto_sam tier2 30d\` (Tier 2 Autopilot Bot — 30 Days)
• \`/grant @crypto_sam lifetime\` (Lifetime Whale Syndicate)

💡 _Tap any example above to copy it, replace the username, and send._`;
            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('💎 View Pricing Plans', 'action_pricing')],
                [Markup.button.callback('🔙 Back to VIP Menu', 'help_cat_vip'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);
            await this.safeEditOrReply(ctx, text, markup);
        });

        this.bot.action('action_cmd_revoke', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`🚫 *COMMAND: /revoke*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Immediately revoke a member's access and remove them from your private channel.

*Usage:*
\`/revoke @username\`

*Example:*
\`/revoke @crypto_sam\``;
            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('👥 View Members List', 'action_members')],
                [Markup.button.callback('🔙 Back to VIP Menu', 'help_cat_vip'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);
            await this.safeEditOrReply(ctx, text, markup);
        });

        this.bot.action('action_cmd_setchannel', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const currentChannel = await this.getTargetChannelId();
            const text =
`⚙️ *COMMAND: /setchannel*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Connect your private Telegram VIP channel to Razor so the bot can generate single-use invite links and post signals.

*Current Linked Channel:* \`${currentChannel || 'None'}\`

*Usage:*
\`/setchannel <channel_id>\`

*Example:*
\`/setchannel -1003985019043\`

*3 Steps to Setup:*
1. Create a private Telegram channel.
2. Add this bot as an **Administrator** with Invite Users and Ban Users permissions.
3. Forward any post from that channel to @JsonDumpBot or @userinfobot to get your \`-100...\` channel ID, then send \`/setchannel <id>\` here!`;
            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Back to VIP Menu', 'help_cat_vip'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);
            await this.safeEditOrReply(ctx, text, markup);
        });

        // Command Button Actions (Whales)
        this.bot.action('action_cmd_watch', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`🎯 *COMMAND: /watch*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Start monitoring any Solana whale wallet in real time. Razor detects all buys and sells across pump.fun and Raydium.

*Usage:*
\`/watch <wallet_address>\`

*Example:*
\`/watch AH39BneW9UeWxQysUcwogQrYFdPvJuRVZ5w4ccq9SKfL\`

💡 *Pro-Tip:* You can also just paste any Solana wallet address directly into this chat!`;
            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('📜 Monitored Wallets', 'action_list')],
                [Markup.button.callback('🔙 Back to Whales', 'help_cat_whales'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);
            await this.safeEditOrReply(ctx, text, markup);
        });

        this.bot.action('action_cmd_remove', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`🗑️ *COMMAND: /remove*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Stop monitoring a whale wallet and remove them from tracking.

*Usage:*
\`/remove <wallet_address>\`

💡 _Tip: Tap 'View & Untrack Wallets' below to see active whales and untrack any of them with one tap!_`;
            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('📜 View & Untrack Wallets', 'action_list')],
                [Markup.button.callback('🔙 Back to Whales', 'help_cat_whales'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);
            await this.safeEditOrReply(ctx, text, markup);
        });

        // Command Button Actions (Settings)
        this.bot.action('action_cmd_threshold', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const tradeEngine = require('./trade-engine.service');
            const text =
`🎯 *COMMAND: /threshold*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Set the minimum Market Cap required before Razor saves a newly discovered token to memory.

*Current Threshold:* \`$${tradeEngine.watchlistThresholdUSD.toLocaleString()} USD\`

*Usage:*
\`/threshold <amount_usd>\`

*Examples:*
• \`/threshold 5000\` (Set gate to $5,000 MC)
• \`/threshold 10000\` (Set gate to $10,000 MC)`;
            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('⚙️ Early CA Menu', 'action_earlyca_menu')],
                [Markup.button.callback('🔙 Back to Settings', 'help_cat_settings'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);
            await this.safeEditOrReply(ctx, text, markup);
        });

        // Legacy Aliases
        this.bot.action(['help_cat_copy', 'help_cat_wallets'], async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const text =
`🎯 *WHALE TRACKING & MONITORS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Monitor high-conviction Solana whale wallets. Whenever they buy or sell, Razor detects it instantly and posts alerts.

*Tap any command button below to run it or view setup:*`;
            await this.safeEditOrReply(ctx, text, this.getWhalesHelpButtons());
        });

        this.bot.action(['help_cat_sniper', 'help_cat_risk'], async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const tradeEngine = require('./trade-engine.service');
            const isEnabled = tradeEngine.earlyCADiscoveryEnabled;
            const threshK = Math.round(tradeEngine.watchlistThresholdUSD / 1000);
            const text =
`⚙️ *SETTINGS & EARLY CA DISCOVERY*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Control automatic early token discovery (milestone sniper) and customize market cap thresholds to filter out zero-volume rugs.

• *Early Discovery:* ${isEnabled ? '🟢 ACTIVE' : '🔴 PAUSED'}
• *Watchlist Gate:* \`$${tradeEngine.watchlistThresholdUSD.toLocaleString()} USD\` (${threshK}K MC)

*Tap any command button below:*`;
            await this.safeEditOrReply(ctx, text, this.getSettingsHelpButtons());
        });
    }

    async handlePositions(ctx) {
        try {
            const [openTrades, recentClosed] = await Promise.all([
                ActiveTrade.find({ status: { $in: ['OPEN', 'PARTIAL_TP_2X', 'REENTERED', 'TP_TAKEN_WAITING_REENTRY'] } }).sort({ createdAt: -1 }),
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
                    const statusBadge = t.status === 'PARTIAL_TP_2X' 
                        ? '🎯 2x TP Taken (Holding 25% Moonbag)' 
                        : (t.status === 'REENTERED' ? '🔄 Re-entered (Dip)' : (t.status === 'TP_TAKEN_WAITING_REENTRY' ? '⏳ TP Taken' : '⚡ Open'));
                    const entryDesc = t.entryMarketCapUSD > 0 
                        ? `$${t.entryMarketCapUSD >= 1000 ? Math.round(t.entryMarketCapUSD / 1000) + 'k' : Math.round(t.entryMarketCapUSD)} MC`
                        : `${t.entryMarketCap?.toFixed(2) || '0'} SOL MC`;
                    text += `${i + 1}. *${t.tokenName || 'Token'}* (\`${shortMint}\`)\n` +
                            `   • *Status:* ${statusBadge}\n` +
                            `   • *Invested:* \`${t.amountSolInvested?.toFixed(4) || '0'} SOL\` (Entry: \`${entryDesc}\`)\n` +
                            `   • *Rules:* 2x TP (Sell 75%) • Whale Sell (All) • -54% SL\n` +
                            `   • *Links:* [DexScreener](https://dexscreener.com/solana/${t.mint}) | [Pump.fun](https://pump.fun/${t.mint}) | [Solscan](https://solscan.io/token/${t.mint})\n\n`;
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

🔫 *Execution & Exit Rules:*
• *Take Profit (2x):* \`2.0x (+100%)\` ➔ Sell \`75%\`, hold \`25%\` moonbag
• *Whale Mirror Exit:* Whale sells ➔ Sell \`100% (ALL)\` immediately
• *Stop Loss Guard:* \`-54%\` drop from entry ➔ Sell \`100%\` sell off
• *Monitoring Loop:* Continuous 10-second active trade price monitor
• *Early CA Discovery:* \`${earlyCAStatus}\`
• *Watchlist Gate:* \`> ${watchlistGate}\` Market Cap

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
`⚡ *RAZOR CONTROL & COMMAND DIRECTORY*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Welcome to the Razor Command Center. All features and tools are organized into categories below.

*Tap a category below to see and run its commands:*`;

        return this.safeEditOrReply(ctx, helpText, this.getHelpCategoryButtons());
    }

    async safeEditOrReply(ctx, text, markup = {}) {
        if (ctx.callbackQuery && !ctx.callbackQuery.message?.photo) {
            try {
                await ctx.editMessageText(text, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true,
                    ...markup
                });
                return;
            } catch (err) {
                if (err.message && err.message.includes('message is not modified')) return;
            }
        }
        await ctx.reply(text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...markup
        }).catch(() => {});
    }

    async handleMembers(ctx) {
        try {
            const activeMembers = await ChannelMember.find({ isActive: true }).sort({ expiresAt: 1 });
            if (activeMembers.length === 0) {
                const emptyMsg =
`👥 *RAZOR VIP CHANNEL MEMBERSHIP DASHBOARD*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*Active Members:* 0

No active demo trials or paid subscribers found.

💡 *To invite a prospect for a 24h demo trial:*
Type \`/demo @username\` or tap the button below.`;

                const markup = Markup.inlineKeyboard([
                    [Markup.button.callback('🎟️ Create 24h Demo Pass', 'action_cmd_demo')],
                    [Markup.button.callback('🔙 Back to VIP Menu', 'help_cat_vip'), Markup.button.callback('🔙 All Categories', 'action_help')]
                ]);
                return this.safeEditOrReply(ctx, emptyMsg, markup);
            }

            let demoList = [];
            let paidList = [];
            let pendingList = [];
            const now = Date.now();

            for (const m of activeMembers) {
                const handle = m.username ? `@${m.username}` : `ID: ${m.telegramUserId}`;
                if (m.status === 'PENDING_JOIN') {
                    pendingList.push(`• ${handle} (Invite created, waiting to join)`);
                } else if (m.tier === 'DEMO') {
                    const msLeft = m.expiresAt ? m.expiresAt.getTime() - now : 0;
                    const hoursLeft = Math.floor(msLeft / 3600000);
                    const minsLeft = Math.floor((msLeft % 3600000) / 60000);
                    const timeLeftStr = hoursLeft > 0 ? `${hoursLeft}h ${minsLeft}m left` : `${Math.max(0, minsLeft)}m left`;
                    demoList.push(`• ${handle} — ⏳ *${timeLeftStr}*`);
                } else {
                    const tierName = m.tier === 'TIER_1_SIGNALS' ? 'Tier 1 Signals' : m.tier === 'TIER_2_BOT' ? 'Tier 2 Bot' : 'Lifetime';
                    const dateStr = m.expiresAt ? m.expiresAt.toLocaleDateString() : 'Never';
                    paidList.push(`• ${handle} — 👑 *${tierName}* (Exp: ${dateStr})`);
                }
            }

            let resp = `👥 *RAZOR VIP CHANNEL MEMBERSHIP DASHBOARD*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            if (demoList.length > 0) {
                resp += `🎟️ *Active 24h Demos (${demoList.length}):*\n${demoList.join('\n')}\n\n`;
            }
            if (paidList.length > 0) {
                resp += `👑 *Active Paid Subscribers (${paidList.length}):*\n${paidList.join('\n')}\n\n`;
            }
            if (pendingList.length > 0) {
                resp += `⏳ *Pending Invites (${pendingList.length}):*\n${pendingList.join('\n')}\n\n`;
            }

            resp += `💡 *Quick Admin Actions:*\n• Extend: \`/extend @user 24h\`\n• Grant Paid: \`/grant @user tier1 30d\`\n• Revoke: \`/revoke @user\``;

            const markup = Markup.inlineKeyboard([
                [Markup.button.callback('🎟️ /demo (New Pass)', 'action_cmd_demo'), Markup.button.callback('⏳ /extend (Add Time)', 'action_cmd_extend')],
                [Markup.button.callback('👑 /grant (Give VIP)', 'action_cmd_grant'), Markup.button.callback('🚫 /revoke (Kick User)', 'action_cmd_revoke')],
                [Markup.button.callback('🔙 Back to VIP Menu', 'help_cat_vip'), Markup.button.callback('🔙 All Categories', 'action_help')]
            ]);

            await this.safeEditOrReply(ctx, resp, markup);
        } catch (e) {
            console.error("[TELEGRAM] ❌ Error in handleMembers:", e.message);
            ctx.reply(`❌ Error loading members: ${e.message}`).catch(() => {});
        }
    }

    async handlePricing(ctx) {
        const pricingMsg =
`💎 *RAZOR ALPHA VIP — SUBSCRIPTION PLANS* 💎
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1️⃣ *TIER 1: VIP SIGNAL PASS*
💰 *Price:* \`0.75 SOL / Month\` (~$110 - $130)
👉 *What You Get:*
• 24/7 access to the private VIP Signal Channel.
• Instant BUY alerts the second top insiders buy.
• Instant SELL alerts when it's time to take profit.
• Real dollar profit and ROI proof on every call.
• Best for: Manual traders on their phone.

2️⃣ *TIER 2: AUTOPILOT BOT* ⭐ *Most Popular*
💰 *Price:* \`2.50 SOL / Month\` (~$350 - $400)
👉 *What You Get:*
• Everything in Tier 1 (VIP Signals).
• Dedicated automated bot running on your personal wallet.
• Auto-buys when top insiders buy.
• Auto-sells when insiders exit or at 2x TP / -20% SL.
• Built-in 10% max portfolio risk cap.
• Best for: Hands-free profits while sleeping or working.

3️⃣ *TIER 3: LIFETIME WHALE SYNDICATE*
💰 *Price:* \`10.00 SOL One-Time\` (~$1,500)
👉 *What You Get:*
• Lifetime access to VIP Signals and Autopilot Bot forever.
• Never pay monthly subscription fees again.
• Track up to 3 custom whale wallets of your choice.
• Fast-lane priority execution.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💳 *HOW TO ACTIVATE:*
Send the subscription amount to our official bot address:
\`${WALLET_PUBLIC_KEY || 'Contact Admin'}\`

After sending, contact the admin with your transaction hash to activate instantly!`;

        const markup = Markup.inlineKeyboard([
            [Markup.button.callback('💳 View Bot Wallet', 'action_address'), Markup.button.callback('👥 View Members', 'action_members')],
            [Markup.button.callback('🔙 Back to VIP Menu', 'help_cat_vip'), Markup.button.callback('🔙 All Categories', 'action_help')]
        ]);

        await this.safeEditOrReply(ctx, pricingMsg, markup);
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
            const nameBadge = (w.label && w.label !== 'Whale Wallet') ? ` 🏷️ *${w.label}*` : '';
            response += `${i + 1}.${nameBadge}\n   [\`${short}\`](https://solscan.io/account/${w.walletAddress})\n   \`${w.walletAddress}\`\n\n`;
        });
        
        response += `_Tap a button below to remove, or use \`/remove <address>\`_`;

        // Generate quick action buttons for monitored wallets
        const inlineRows = wallets.map(w => {
            const short = `${w.walletAddress.substring(0, 4)}...${w.walletAddress.substring(w.walletAddress.length - 4)}`;
            const btnName = (w.label && w.label !== 'Whale Wallet') ? w.label : short;
            return [
                Markup.button.callback(`🗑️ Untrack ${btnName}`, `unwatch:${w.walletAddress}`),
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

    async getTargetChannelId() {
        try {
            const settings = await BotSettings.findOne({ key: 'global' });
            if (settings && settings.vipChannelId) {
                return settings.vipChannelId;
            }
        } catch {}
        return this.configuredAlertChannel || process.env.TELEGRAM_ALERTS_CHANNEL || null;
    }

    registerChannelManager() {
        if (!this.bot) return;

        // Command: /demo @username [duration]
        this.bot.command('demo', async (ctx) => {
            const text = ctx.message?.text || '';
            const parts = text.split(/\s+/).filter(Boolean);

            if (parts.length < 2) {
                return ctx.reply(
                    `🎟️ *HOW TO GENERATE A 24H VIP DEMO PASS*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `Create a private single-use invite link for a prospect.\n\n` +
                    `*Usage:*\n\`/demo @username [hours]\`\n\n` +
                    `*Examples:*\n` +
                    `• \`/demo @john\` (Defaults to 24 hours)\n` +
                    `• \`/demo @sarah 48h\` (Custom 48 hours)\n` +
                    `• \`/demo @mike 3d\` (Custom 3 days)\n\n` +
                    `💡 *Rules:* Link burns automatically once they join. 24h countdown starts upon entry. Bot kicks them automatically when expired.`,
                    { parse_mode: 'Markdown' }
                );
            }

            const cleanUser = parts[1].replace('@', '').trim().toLowerCase();
            let durationHours = 24;
            if (parts[2]) {
                const dur = parts[2].toLowerCase();
                if (dur.endsWith('d')) durationHours = parseInt(dur) * 24;
                else if (dur.endsWith('h')) durationHours = parseInt(dur);
                else if (!isNaN(dur)) durationHours = parseInt(dur);
            }
            if (isNaN(durationHours) || durationHours <= 0) durationHours = 24;

            const channelId = await this.getTargetChannelId();
            if (!channelId) {
                return ctx.reply(
                    `⚠️ *No VIP Channel Linked Yet!*\n\n` +
                    `To generate demo links, link your private VIP channel first:\n` +
                    `1. Add this bot as an **Administrator** in your private Telegram channel.\n` +
                    `2. Type \`/setchannel <channel_id>\` (e.g. \`/setchannel -1001234567890\`).\n` +
                    `Or set \`TELEGRAM_ALERTS_CHANNEL\` in your \`.env\` file.`,
                    { parse_mode: 'Markdown' }
                );
            }

            const expireTimestamp = Math.floor(Date.now() / 1000) + (durationHours * 3600);
            let invite;
            try {
                invite = await this.bot.telegram.createChatInviteLink(channelId, {
                    name: `Demo @${cleanUser}`,
                    member_limit: 1,
                    expire_date: expireTimestamp
                });
            } catch (err) {
                console.error("[TELEGRAM] ❌ Failed to create invite link:", err.message);
                return ctx.reply(
                    `❌ *Could not generate invite link:* ${err.message}\n\n` +
                    `💡 *Check:* Is the bot added to channel \`${channelId}\` as an **Administrator** with **Invite Users via Link** permissions enabled?`,
                    { parse_mode: 'Markdown' }
                );
            }

            try {
                await ChannelMember.create({
                    username: cleanUser,
                    channelId: String(channelId),
                    tier: 'DEMO',
                    inviteLink: invite.invite_link,
                    durationHours,
                    status: 'PENDING_JOIN',
                    expiresAt: new Date(Date.now() + (durationHours * 3600000)),
                    isActive: true,
                    addedByAdmin: String(ctx.from?.id || 'admin')
                });

                const replyMsg =
`✅ *VIP DEMO PASS READY FOR @${cleanUser}!*
━━━━━━━━━━━━━━━━━━━━━━
⏳ *Duration:* ${durationHours} Hours (Starts when they join)

🔗 *Single-Use Invite Link:*
${invite.invite_link}

📋 *Active Protections:*
• *Single-Use:* Link burns automatically once @${cleanUser} enters.
• *Auto-Kick:* Bot automatically kicks them when ${durationHours}h expires.
• *Extend Anytime:* Type \`/extend @${cleanUser} 24h\` if they need more time.`;

                await ctx.reply(replyMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
            } catch (dbErr) {
                console.error("[TELEGRAM] ❌ Error saving ChannelMember:", dbErr.message);
                ctx.reply(`⚠️ Link created: ${invite.invite_link} (Notice: DB record error: ${dbErr.message})`);
            }
        });

        // Command: /extend @username [hours]
        this.bot.command('extend', async (ctx) => {
            const text = ctx.message?.text || '';
            const parts = text.split(/\s+/).filter(Boolean);

            if (parts.length < 2) {
                return ctx.reply(
                    `⏳ *HOW TO EXTEND A MEMBER'S ACCESS*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `*Usage:*\n\`/extend @username [hours/days]\`\n\n` +
                    `*Examples:*\n` +
                    `• \`/extend @john 24h\` (Extends by 24 hours)\n` +
                    `• \`/extend @sarah 48h\` (Extends by 48 hours)\n` +
                    `• \`/extend @mike 7d\` (Extends by 7 days)`,
                    { parse_mode: 'Markdown' }
                );
            }

            const cleanUser = parts[1].replace('@', '').trim().toLowerCase();
            let hoursToAdd = 24;
            if (parts[2]) {
                const dur = parts[2].toLowerCase();
                if (dur.endsWith('d')) hoursToAdd = parseInt(dur) * 24;
                else if (dur.endsWith('h')) hoursToAdd = parseInt(dur);
                else if (!isNaN(dur)) hoursToAdd = parseInt(dur);
            }
            if (isNaN(hoursToAdd) || hoursToAdd <= 0) hoursToAdd = 24;

            try {
                const member = await ChannelMember.findOne({
                    username: cleanUser,
                    isActive: true
                }).sort({ createdAt: -1 });

                if (!member) {
                    return ctx.reply(`❌ No active membership or pending trial found for @${cleanUser}.`);
                }

                const baseTime = (member.expiresAt && member.expiresAt > new Date()) ? member.expiresAt.getTime() : Date.now();
                member.expiresAt = new Date(baseTime + (hoursToAdd * 3600000));
                member.status = 'ACTIVE';
                member.isActive = true;
                await member.save();

                const remainingHours = Math.max(1, Math.round((member.expiresAt.getTime() - Date.now()) / 3600000));
                await ctx.reply(
                    `✅ *VIP Pass Extended for @${cleanUser}!*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `• *Added:* +${hoursToAdd} Hours\n` +
                    `• *New Expiration:* \`${member.expiresAt.toLocaleString()}\`\n` +
                    `• *Total Remaining:* ~${remainingHours} Hours`,
                    { parse_mode: 'Markdown' }
                );

                // Send extension confirmation to user if possible
                if (member.telegramUserId) {
                    try {
                        await this.bot.telegram.sendMessage(
                            member.telegramUserId,
                            `🎁 *Good news!* Your VIP trial access has been extended by +${hoursToAdd} hours.\nEnjoy the signals!`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch {}
                }
            } catch (e) {
                ctx.reply(`❌ Error extending member: ${e.message}`);
            }
        });

        // Command: /grant @username [tier] [duration]
        this.bot.command('grant', async (ctx) => {
            const text = ctx.message?.text || '';
            const parts = text.split(/\s+/).filter(Boolean);

            if (parts.length < 2) {
                return ctx.reply(
                    `👑 *HOW TO GRANT PAID VIP ACCESS*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `*Usage:*\n\`/grant @username [tier] [duration]\`\n\n` +
                    `*Examples:*\n` +
                    `• \`/grant @john tier1 30d\` (Tier 1 Signals — 30 Days)\n` +
                    `• \`/grant @sarah tier2 30d\` (Tier 2 Autopilot Bot — 30 Days)\n` +
                    `• \`/grant @mike lifetime\` (Lifetime Whale Syndicate — Forever)`,
                    { parse_mode: 'Markdown' }
                );
            }

            const cleanUser = parts[1].replace('@', '').trim().toLowerCase();
            const rawTier = (parts[2] || 'tier1').toLowerCase();
            const tier = rawTier.includes('2') || rawTier.includes('bot')
                ? 'TIER_2_BOT'
                : rawTier.includes('life')
                ? 'TIER_3_LIFETIME'
                : 'TIER_1_SIGNALS';

            let days = 30;
            if (tier === 'TIER_3_LIFETIME') {
                days = 36500; // 100 years
            } else if (parts[3]) {
                const dur = parts[3].toLowerCase();
                if (dur.endsWith('d')) days = parseInt(dur);
                else if (dur.endsWith('m')) days = parseInt(dur) * 30;
                else if (!isNaN(dur)) days = parseInt(dur);
            }
            if (isNaN(days) || days <= 0) days = 30;

            const channelId = await this.getTargetChannelId();
            if (!channelId) {
                return ctx.reply(`⚠️ No VIP Channel linked! Run /setchannel <channel_id> first.`);
            }

            try {
                let member = await ChannelMember.findOne({
                    username: cleanUser,
                    isActive: true
                }).sort({ createdAt: -1 });

                const expiresAt = new Date(Date.now() + (days * 86400000));

                if (member) {
                    member.tier = tier;
                    member.expiresAt = expiresAt;
                    member.status = 'ACTIVE';
                    member.isActive = true;
                    await member.save();

                    ctx.reply(
                        `👑 *Upgraded @${cleanUser} to ${tier}!*\n` +
                        `• *Expires:* \`${tier === 'TIER_3_LIFETIME' ? 'Never (Lifetime)' : expiresAt.toLocaleDateString()}\`\n` +
                        `Access confirmed in VIP Channel.`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    const invite = await this.bot.telegram.createChatInviteLink(channelId, {
                        name: `VIP ${tier}: @${cleanUser}`,
                        member_limit: 1
                    });

                    await ChannelMember.create({
                        username: cleanUser,
                        channelId: String(channelId),
                        tier,
                        inviteLink: invite.invite_link,
                        durationHours: days * 24,
                        status: 'PENDING_JOIN',
                        expiresAt,
                        isActive: true,
                        addedByAdmin: String(ctx.from?.id || 'admin')
                    });

                    ctx.reply(
                        `👑 *Paid Access Granted for @${cleanUser} (${tier})!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `🔗 *Single-Use VIP Invite Link:*\n${invite.invite_link}\n\n` +
                        `• *Duration:* ${days >= 36500 ? 'Lifetime Access' : `${days} Days`}\n` +
                        `Send this link to @${cleanUser} to join the VIP Channel.`,
                        { parse_mode: 'Markdown', disable_web_page_preview: true }
                    );
                }
            } catch (e) {
                ctx.reply(`❌ Error granting access: ${e.message}`);
            }
        });

        // Command: /revoke @username
        this.bot.command('revoke', async (ctx) => {
            const text = ctx.message?.text || '';
            const parts = text.split(/\s+/).filter(Boolean);

            if (parts.length < 2) {
                return ctx.reply(`*Usage:* \`/revoke @username\` to remove a user from the VIP channel.`);
            }

            const cleanUser = parts[1].replace('@', '').trim().toLowerCase();
            try {
                const member = await ChannelMember.findOne({
                    username: cleanUser,
                    isActive: true
                }).sort({ createdAt: -1 });

                if (!member) {
                    return ctx.reply(`❌ No active member found for @${cleanUser}.`);
                }

                if (member.telegramUserId && member.channelId) {
                    try {
                        await this.bot.telegram.banChatMember(member.channelId, Number(member.telegramUserId), { until_date: Math.floor(Date.now() / 1000) + 60 });
                        await this.bot.telegram.unbanChatMember(member.channelId, Number(member.telegramUserId));
                    } catch (kickErr) {
                        console.warn(`[CHANNEL-MGR] Kick notice:`, kickErr.message);
                    }
                }

                member.isActive = false;
                member.status = 'REVOKED';
                member.kickedAt = new Date();
                await member.save();

                ctx.reply(`🚫 *Revoked VIP Access:* Removed @${cleanUser} from the channel.`, { parse_mode: 'Markdown' });
            } catch (e) {
                ctx.reply(`❌ Error revoking member: ${e.message}`);
            }
        });

        // Command: /members
        this.bot.command('members', async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /members command from user: ${ctx.chat.id}`);
            await this.handleMembers(ctx);
        });

        // Command: /setchannel <channel_id>
        this.bot.command('setchannel', async (ctx) => {
            const text = ctx.message?.text || '';
            const parts = text.split(/\s+/).filter(Boolean);

            if (parts.length < 2) {
                const currentChannel = await this.getTargetChannelId();
                return ctx.reply(
                    `⚙️ *HOW TO LINK YOUR VIP CHANNEL*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `*Current Linked Channel:* \`${currentChannel || 'None'}\`\n\n` +
                    `*Usage:*\n\`/setchannel <channel_id>\`\n\n` +
                    `*Example:*\n\`/setchannel -1003985019043\`\n\n` +
                    `💡 *How to get Channel ID:*\n` +
                    `1. Create a Private Telegram Channel.\n` +
                    `2. Add this bot as an **Administrator** with Invite Users and Ban Users permissions.\n` +
                    `3. Forward any post from that channel to @userinfobot or @JsonDumpBot to get the \`-100...\` Channel ID.\n` +
                    `4. Run \`/setchannel -100...\` here!`,
                    { parse_mode: 'Markdown' }
                );
            }

            const channelId = parts[1].trim();
            try {
                const chat = await this.bot.telegram.getChat(channelId);
                await BotSettings.findOneAndUpdate(
                    { key: 'global' },
                    { vipChannelId: channelId },
                    { upsert: true, new: true }
                );
                this.configuredAlertChannel = channelId;

                ctx.reply(
                    `✅ *VIP Channel Successfully Linked!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `• *Channel Title:* ${chat.title || 'Private Channel'}\n` +
                    `• *Channel ID:* \`${channelId}\`\n` +
                    `• *Status:* Confirmed Administrator with Invite & Kick rights.\n\n` +
                    `All single-use demo invite links and VIP signals are now linked to this channel!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {
                ctx.reply(
                    `❌ *Could not link channel:* ${e.message}\n\n` +
                    `💡 *Make sure:*\n1. The channel ID starts with \`-100\`.\n2. The bot is already an **Administrator** in the channel!`,
                    { parse_mode: 'Markdown' }
                );
            }
        });

        // Command: /pricing
        this.bot.command('pricing', async (ctx) => {
            console.log(`[TELEGRAM] 📥 Received /pricing command from user: ${ctx.chat.id}`);
            await this.handlePricing(ctx);
        });

        // Listener: chat_member (Triggers when user joins via single-use invite link)
        this.bot.on('chat_member', async (ctx) => {
            try {
                const update = ctx.chatMember;
                const chat = update.chat;
                const newMember = update.new_chat_member;
                const oldMember = update.old_chat_member;

                // Detect when a user joins the channel
                if (newMember.status === 'member' && oldMember.status !== 'member') {
                    const userId = String(newMember.user.id);
                    const username = newMember.user.username ? newMember.user.username.toLowerCase() : null;
                    const inviteUsed = update.invite_link?.invite_link;

                    console.log(`[CHANNEL-MGR] 👤 User joined channel ${chat.id}: @${username || userId}`);

                    let memberRecord = null;
                    if (inviteUsed) {
                        memberRecord = await ChannelMember.findOne({ inviteLink: inviteUsed });
                    }
                    if (!memberRecord && username) {
                        memberRecord = await ChannelMember.findOne({ username, status: 'PENDING_JOIN' });
                    }

                    if (memberRecord) {
                        memberRecord.telegramUserId = userId;
                        if (username) memberRecord.username = username;
                        memberRecord.joinedAt = new Date();
                        memberRecord.status = 'ACTIVE';
                        memberRecord.isActive = true;
                        memberRecord.expiresAt = new Date(Date.now() + (memberRecord.durationHours || 24) * 3600000);
                        await memberRecord.save();

                        console.log(`[CHANNEL-MGR] ⏱️ Started ${memberRecord.durationHours}h countdown for @${username || userId}. Expires at: ${memberRecord.expiresAt.toISOString()}`);

                        // Send welcome DM to user
                        try {
                            const welcomeMsg =
`🎉 *Welcome to Razor Alpha VIP Demo!*

Your *${memberRecord.durationHours}-Hour Pass* is now active!

👉 *How it works:*
• When our top insider buys a token, you will get a 🟢 *NEW BUY SIGNAL* with the contract address.
• When they cash out, you will get a 🔴 *SELL NOW & TAKE PROFIT* alert.

⏱️ *Your Trial Expires:* \`${memberRecord.expiresAt.toLocaleString()}\`

💡 Type /pricing anytime to view full subscription plans.`;

                            await this.bot.telegram.sendMessage(userId, welcomeMsg, { parse_mode: 'Markdown' });
                        } catch {}
                    }
                }
            } catch (e) {
                console.warn("[CHANNEL-MGR] ⚠️ Error in chat_member handler:", e.message);
            }
        });
    }

    startExpirationWorker() {
        if (this.expirationInterval) clearInterval(this.expirationInterval);
        // Run every 2 minutes
        this.expirationInterval = setInterval(() => this.checkExpiredMembers(), 120000);
        console.log("[CHANNEL-MGR] ⏱️ Member auto-kick expiration worker active (checking every 2m).");
    }

    async checkExpiredMembers() {
        if (!this.bot) return;
        try {
            const now = new Date();
            const expiredMembers = await ChannelMember.find({
                isActive: true,
                status: 'ACTIVE',
                expiresAt: { $lte: now }
            });

            for (const m of expiredMembers) {
                try {
                    console.log(`[CHANNEL-MGR] ⏳ Demo expired for @${m.username || m.telegramUserId}. Removing from channel ${m.channelId}...`);

                    if (m.telegramUserId && m.channelId) {
                        // 1. Kick user from channel (ban for 60s)
                        await this.bot.telegram.banChatMember(m.channelId, Number(m.telegramUserId), { until_date: Math.floor(Date.now() / 1000) + 60 });
                        // 2. Immediately unban so they can rejoin in future once they pay
                        await this.bot.telegram.unbanChatMember(m.channelId, Number(m.telegramUserId));
                    }

                    m.isActive = false;
                    m.status = 'EXPIRED';
                    m.kickedAt = new Date();
                    await m.save();

                    console.log(`[CHANNEL-MGR] ✅ Successfully kicked expired member @${m.username || m.telegramUserId}.`);

                    // 3. Send conversion / upgrade pitch DM to user
                    if (m.telegramUserId) {
                        try {
                            const upgradePitch =
`⏳ *Your Razor VIP Demo Pass has Expired!*

We hope you enjoyed watching live top-trader calls! Over your trial, Razor closed multiple profitable meme coin setups.

🚀 *Ready to keep winning? Upgrade your access:*

1️⃣ *Tier 1: VIP Signal Pass* — \`0.75 SOL / Month\`
• Live BUY & SELL signals on Telegram

2️⃣ *Tier 2: Autopilot Bot* — \`2.5 SOL / Month\` ⭐ *Most Popular*
• Bot automatically buys & sells in your personal wallet while you sleep

3️⃣ *Tier 3: Lifetime Whale Syndicate* — \`10 SOL One-Time\`
• Lifetime VIP access forever (no monthly fees) + custom wallet tracking

👉 *To activate:* Contact our admin or send payment to the bot deposit address:
\`${WALLET_PUBLIC_KEY || 'Contact Admin'}\`
`;
                            await this.bot.telegram.sendMessage(m.telegramUserId, upgradePitch, {
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true
                            });
                        } catch {}
                    }
                } catch (kickErr) {
                    console.warn(`[CHANNEL-MGR] ⚠️ Could not kick member ${m.telegramUserId}:`, kickErr.message);
                }
            }
        } catch (e) {
            console.error("[CHANNEL-MGR] ❌ Error in checkExpiredMembers worker:", e.message);
        }
    }

    async sendAdminDirectMessage(text) {
        if (!this.bot) return;
        try {
            let adminChatId = this.adminChatId || null;
            if (!adminChatId) {
                const settings = await BotSettings.findOne({ key: 'global' });
                if (settings && settings.adminChatId) {
                    adminChatId = String(settings.adminChatId);
                }
            }
            if (!adminChatId) {
                console.warn("[TELEGRAM] ⚠️ No adminChatId configured for direct admin alert.");
                return;
            }

            // Deduplication: prevent sending identical messages within 60 seconds
            if (!this.recentDirectAdminMessages) this.recentDirectAdminMessages = new Map();
            const now = Date.now();
            const lastSent = this.recentDirectAdminMessages.get(text);
            if (lastSent && (now - lastSent) < 60000) {
                console.log("[TELEGRAM] ℹ️ Suppressed duplicate direct admin message within 60s cooldown.");
                return;
            }
            this.recentDirectAdminMessages.set(text, now);

            // Cleanup map if large
            if (this.recentDirectAdminMessages.size > 100) {
                for (const [k, v] of this.recentDirectAdminMessages.entries()) {
                    if (now - v > 60000) this.recentDirectAdminMessages.delete(k);
                }
            }

            const sendOpts = {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            };

            await this.bot.telegram.sendMessage(adminChatId, text, sendOpts).catch(async (err) => {
                console.warn("[TELEGRAM] ⚠️ Markdown parse failed for admin direct message, sending fallback plain text:", err.message);
                const plainText = text.replace(/[*_`]/g, '');
                await this.bot.telegram.sendMessage(adminChatId, plainText, { disable_web_page_preview: true });
            });

            console.log(`[TELEGRAM] ✉️ Direct admin notification sent strictly to admin private chat: ${adminChatId}`);
        } catch (err) {
            console.error("[TELEGRAM] ❌ Failed to send direct admin message:", err.message);
        }
    }

    async sendAlert(adminMessage, groupMessage = null, mint = null) {
        if (!this.bot) return;

        const adminMsg = adminMessage;
        const groupMsg = groupMessage || adminMessage;

        // Auto-extract mint from CA line if not explicitly passed
        let targetMint = mint;
        if (!targetMint) {
            const match = adminMsg.match(/🏷️ \*CA:\* `([1-9A-HJ-NP-Za-km-z]{32,44})`/);
            if (match) targetMint = match[1];
        }

        let inlineMarkup = null;
        if (targetMint) {
            inlineMarkup = Markup.inlineKeyboard([
                [
                    Markup.button.url('📊 DexScreener', `https://dexscreener.com/solana/${targetMint}`),
                    Markup.button.url('💊 Pump.fun', `https://pump.fun/${targetMint}`),
                    Markup.button.url('🔎 Solscan', `https://solscan.io/token/${targetMint}`)
                ]
            ]).reply_markup;
        }

        // 1. Identify VIP channel (Group destination for prospects/subscribers)
        let vipChannelId = null;
        try {
            const settings = await BotSettings.findOne({ key: 'global' });
            if (settings && settings.vipChannelId) {
                vipChannelId = String(settings.vipChannelId);
            }
        } catch {}

        // 2. Identify Admin Chat ID
        let adminChatId = this.adminChatId || null;
        try {
            const settings = await BotSettings.findOne({ key: 'global' });
            if (settings && settings.adminChatId) {
                adminChatId = String(settings.adminChatId);
            }
        } catch {}

        const adminTargets = new Set();
        const groupTargets = new Set();

        // The VIP group / channel gets groupMsg (where private whale wallet links are masked)
        if (vipChannelId) {
            groupTargets.add(vipChannelId);
        }

        // Admin private chat gets adminMsg (full details, whale Solscan links, PnL)
        if (adminChatId && (!vipChannelId || adminChatId !== vipChannelId)) {
            adminTargets.add(adminChatId);
        }

        // Wallets addedBy (admin who typed /watch in private chat or bot)
        try {
            const wallets = await WatchedWallet.find({ isActive: true });
            wallets.forEach(w => {
                if (w.addedBy && w.addedBy !== 'unknown' && w.addedBy !== 'inline') {
                    const id = String(w.addedBy);
                    if (!vipChannelId || id !== vipChannelId) {
                        adminTargets.add(id);
                    }
                }
            });
        } catch {}

        // ChannelMember addedByAdmin
        try {
            const members = await ChannelMember.find({ isActive: true });
            members.forEach(m => {
                if (m.addedByAdmin && m.addedByAdmin !== 'admin' && m.addedByAdmin !== 'unknown') {
                    const id = String(m.addedByAdmin);
                    if (!vipChannelId || id !== vipChannelId) {
                        adminTargets.add(id);
                    }
                }
            });
        } catch {}

        // Configured channels: TELEGRAM_ALERTS_CHANNEL from .env or configuredAlertChannel
        const envAlertChannel = process.env.TELEGRAM_ALERTS_CHANNEL;
        const cfgAlertChannel = this.configuredAlertChannel;

        if (envAlertChannel) {
            const id = String(envAlertChannel);
            if (vipChannelId && id === vipChannelId) {
                groupTargets.add(id);
            } else {
                adminTargets.add(id);
            }
        }

        if (cfgAlertChannel) {
            const id = String(cfgAlertChannel);
            if (vipChannelId && id === vipChannelId) {
                groupTargets.add(id);
            } else {
                adminTargets.add(id);
            }
        }

        if (adminTargets.size === 0 && groupTargets.size === 0) {
            console.log("[TELEGRAM] ⚠️ No active alert channels or subscribers configured.");
            return;
        }

        console.log(`[TELEGRAM] 📤 Dispatching alert ➔ Admin Targets (${adminTargets.size}): [${[...adminTargets].join(', ')}], Group Targets (${groupTargets.size}): [${[...groupTargets].join(', ')}]`);

        // Send full details to Admin
        for (const targetId of adminTargets) {
            const sendOpts = {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            };
            if (inlineMarkup) sendOpts.reply_markup = inlineMarkup;

            try {
                await this.bot.telegram.sendMessage(targetId, adminMsg, sendOpts);
            } catch (err) {
                if (err.message.includes("can't parse entities") || err.message.includes('find end of the entity')) {
                    try {
                        const plainText = adminMsg.replace(/[*_`\[\]()]/g, '');
                        const fallbackOpts = inlineMarkup ? { reply_markup: inlineMarkup } : {};
                        await this.bot.telegram.sendMessage(targetId, plainText, fallbackOpts);
                    } catch {}
                } else {
                    console.warn(`[TELEGRAM] ⚠️ Admin alert dispatch notice for ${targetId}:`, err.message);
                }
            }
        }

        // Send to Group
        for (const targetId of groupTargets) {
            const sendOpts = {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            };
            if (inlineMarkup) sendOpts.reply_markup = inlineMarkup;

            try {
                await this.bot.telegram.sendMessage(targetId, groupMsg, sendOpts);
            } catch (err) {
                if (err.message.includes("can't parse entities") || err.message.includes('find end of the entity')) {
                    try {
                        const plainText = groupMsg.replace(/[*_`\[\]()]/g, '');
                        const fallbackOpts = inlineMarkup ? { reply_markup: inlineMarkup } : {};
                        await this.bot.telegram.sendMessage(targetId, plainText, fallbackOpts);
                    } catch {}
                } else {
                    console.warn(`[TELEGRAM] ⚠️ Group alert dispatch notice for ${targetId}:`, err.message);
                }
            }
        }
    }
}

module.exports = new TelegramService();
