// Trading configuration. Every value can be overridden from the environment.
// Defaults are deliberately conservative: the bot starts in PAPER mode and never
// puts the whole wallet into one trade.

function num(env, name, def, min, max) {
    const raw = env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return def;
    const v = Number(raw);
    if (!Number.isFinite(v)) return def;
    if (min !== undefined && v < min) return min;
    if (max !== undefined && v > max) return max;
    return v;
}

function loadTradingConfig(env = process.env) {
    const mode = String(env.TRADING_MODE || 'paper').trim().toLowerCase() === 'live' ? 'live' : 'paper';
    return {
        // 'paper' records simulated fills and never broadcasts. 'live' trades real funds.
        mode,
        isPaper: mode === 'paper',

        // Position sizing
        tradeFraction: num(env, 'TRADE_FRACTION', 0.25, 0.01, 0.7), // share of balance per trade
        minTradeSol: num(env, 'MIN_TRADE_SOL', 0.05, 0),           // below this, fixed costs eat the trade
        maxTradeSol: num(env, 'MAX_TRADE_SOL', 0, 0),              // 0 = no cap
        reserveSol: num(env, 'RESERVE_SOL', 0.01, 0),              // always left in the wallet for exits

        // Execution
        buySlippagePct: num(env, 'BUY_SLIPPAGE_PCT', 20, 1, 100),
        sellSlippagePct: num(env, 'SELL_SLIPPAGE_PCT', 40, 1, 100),
        confirmTimeoutMs: num(env, 'CONFIRM_TIMEOUT_MS', 30000, 5000),
        closeTokenAccounts: String(env.CLOSE_TOKEN_ACCOUNTS || 'true').toLowerCase() !== 'false',

        // RPC budget
        balancePollMs: num(env, 'BALANCE_POLL_MS', 120000, 15000),
        tokenBalancePollMs: num(env, 'TOKEN_BALANCE_POLL_MS', 60000, 10000),
        solPriceMaxAgeMs: num(env, 'SOL_PRICE_MAX_AGE_MS', 10 * 60 * 1000, 60000),

        // Paper trading model
        paperStartSol: num(env, 'PAPER_START_SOL', 1, 0),
        paperSlippagePct: num(env, 'PAPER_SLIPPAGE_PCT', 5, 0, 90),
        paperFeePct: num(env, 'PAPER_FEE_PCT', 1.5, 0, 50) // venue fee + PumpPortal fee, per side
    };
}

module.exports = { loadTradingConfig };
