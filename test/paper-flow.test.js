// End to end run of the trade engine in PAPER mode with the database, RPC,
// Telegram and HTTP layers replaced by in-memory fakes. It exercises the real
// engine code: sizing, simulated fills, exit rules, mirrored exits and stats.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

process.env.TRADING_MODE = 'paper';
process.env.PAPER_START_SOL = '1';
delete process.env.WALLET_PRIVATE_KEY;
delete process.env.WALLET_PUBLIC_KEY;

const SRC = path.join(__dirname, '..', 'src', 'v2');
const MINT = 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump';
const MINT2 = '4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump';
const WHALE = 'HmUt3Jn46j7c7ANdURmEyjSRj8i3Em6MhjQUi37PZ219';

// ---------- tiny in-memory stand-in for a mongoose model ----------
function matches(doc, query) {
    return Object.entries(query || {}).every(([k, cond]) => {
        const v = k === '_id' ? String(doc._id) : doc[k];
        if (cond && typeof cond === 'object' && !(cond instanceof Date) && !cond.toHexString) {
            if ('$in' in cond) return cond.$in.includes(v);
            if ('$ne' in cond) return v !== cond.$ne;
            if ('$gte' in cond) return v >= cond.$gte;
            return String(cond) === String(v);
        }
        return String(cond) === String(v);
    });
}
function query(result) {
    const q = {
        sort: () => q,
        lean: () => q,
        then: (res, rej) => Promise.resolve(result).then(res, rej),
        catch: (rej) => Promise.resolve(result).catch(rej)
    };
    return q;
}
function fakeModel(defaults = {}) {
    const docs = [];
    let seq = 0;
    const model = {
        docs,
        async create(obj) {
            const doc = { ...defaults, ...obj, _id: `id${++seq}`, createdAt: new Date(), sellSignatures: [] };
            doc.save = async () => doc;
            docs.push(doc);
            return doc;
        },
        find: (q) => query(docs.filter(d => matches(d, q))),
        findOne: (q) => query([...docs].reverse().find(d => matches(d, q)) || null),
        findById: (id) => query(docs.find(d => String(d._id) === String(id)) || null),
        async updateOne(q, update) {
            const doc = docs.find(d => matches(d, q));
            if (!doc) return { modifiedCount: 0 };
            for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v;
            for (const [k, v] of Object.entries(update.$set || {})) doc[k] = v;
            for (const [k, v] of Object.entries(update.$push || {})) (doc[k] = doc[k] || []).push(v);
            return { modifiedCount: 1 };
        },
        async aggregate(pipeline) {
            const rows = docs.filter(d => matches(d, pipeline[0].$match));
            return [{
                spent: rows.reduce((s, d) => s + (d.solSpent || 0), 0),
                received: rows.reduce((s, d) => s + (d.solReceived || 0), 0),
                rent: rows.reduce((s, d) => s + (d.rentReclaimed || 0), 0)
            }];
        },
        findOneAndUpdate: async () => null,
        countDocuments: async () => 0
    };
    return model;
}

const ActiveTrade = fakeModel({ status: 'OPEN', mode: 'live', solSpent: 0, solReceived: 0, tokensSold: 0, feesSol: 0, rentPaid: 0, rentReclaimed: 0, accountingIncomplete: false, highestRatioSeen: 1 });
const WhalePosition = fakeModel();
const TokenMetrics = fakeModel();
const WatchedWallet = fakeModel();
const BotSettings = fakeModel();

// ---------- fake bonding curve account ----------
const K = 30e9 * 1.073e15; // pump.fun starting virtual reserves: 30 SOL x 1.073B tokens
let virtualSol = 32e9;      // lamports
function curveAccount() {
    const data = Buffer.alloc(49);
    data.writeBigUInt64LE(BigInt(Math.round(K / virtualSol)), 8);
    data.writeBigUInt64LE(BigInt(Math.round(virtualSol)), 16);
    data.writeUInt8(0, 48);
    return { data };
}
/** Move the curve so the spot price is multiplied by `factor`. */
function movePrice(factor) { virtualSol = virtualSol * Math.sqrt(factor); }
function spotMcSol() { return ((virtualSol / 1e9) / ((K / virtualSol) / 1e6)) * 1e9; }

const sent = { admin: [], alerts: [], httpPosts: 0 };
const solanaService = {
    connection: { getAccountInfo: async () => curveAccount(), onAccountChange() {}, onLogs() {} },
    getSolPriceUSD: () => 100,
    isSolPriceFresh: () => true,
    getTokenSupplySafe: async () => 1e9,
    getSolBalance: async () => null,
    getTokenBalance: async () => null,
    withFallback(fn) { return fn(this.connection); },
    fetchOnChainMetadata: async () => null
};
const telegramService = {
    sendAdminDirectMessage: async (t) => { sent.admin.push(t); },
    sendAlert: (a, g) => { sent.alerts.push({ a, g }); }
};

function inject(file, exports) {
    const id = require.resolve(file);
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exports;
    require.cache[id] = m;
}
inject(path.join(SRC, 'models', 'ActiveTrade.js'), ActiveTrade);
inject(path.join(SRC, 'models', 'WhalePosition.js'), WhalePosition);
inject(path.join(SRC, 'models', 'TokenMetrics.js'), TokenMetrics);
inject(path.join(SRC, 'models', 'WatchedWallet.js'), WatchedWallet);
inject(path.join(SRC, 'models', 'BotSettings.js'), BotSettings);
inject(path.join(SRC, 'services', 'solana.service.js'), solanaService);
inject(path.join(SRC, 'services', 'telegram.service.js'), telegramService);
inject(path.join(SRC, 'services', 'pumpportal.service.js'), { watchToken() {} });
inject('axios', {
    get: async () => ({ data: { pairs: [] } }),
    post: async () => { sent.httpPosts++; throw new Error('paper mode must never call PumpPortal'); }
});

const engine = require(path.join(SRC, 'services', 'trade-engine.service.js'));
const { summarizeTrades, realizedPnlSol } = require(path.join(SRC, 'utils', 'trade-math.js'));

test('engine boots in paper mode', () => {
    assert.equal(engine.cfg.mode, 'paper');
    assert.equal(engine.cfg.tradeFraction, 0.25);
});

test('sizing uses a fraction of the paper balance, not all of it', async () => {
    const s = await engine.sizeNextTrade();
    assert.equal(s.balanceSol, 1);
    assert.equal(s.sizeSol, 0.25);
});

test('winning paper trade: buy, 1.4x take profit sells 75%, trailing stop sells the moonbag', async () => {
    const sig = await engine.executeTradeLocal(MINT, 'buy', 0.25, true, 0.0001, 'COPY_TRADE', WHALE);
    assert.match(sig, /^PAPER-/);
    const trade = ActiveTrade.docs.find(d => d.mint === MINT);
    assert.equal(trade.mode, 'paper');
    assert.equal(trade.status, 'OPEN');
    assert.ok(trade.tokensReceived > 0);
    assert.ok(trade.solSpent > 0.25 && trade.solSpent < 0.26, `all in cost ${trade.solSpent}`);
    assert.ok(trade.entryMarketCap > 0);
    // We paid above the spot price (own impact + assumed slippage + fees), so the trade starts under water.
    assert.ok(trade.entryMarketCap > spotMcSol(), 'entry must be worse than the pre trade spot price');
    assert.equal(sent.alerts.length, 0, 'paper fills must never reach the public channel');
    assert.equal(sent.admin.length, 1);
    assert.match(sent.admin[0], /PAPER/);

    // Flat price: no exit rule may fire.
    await engine.evaluateActiveTrades(MINT, spotMcSol());
    assert.equal(trade.status, 'OPEN');

    // Price runs. 1.4x of OUR entry triggers the 75% take profit.
    movePrice(1.7);
    await engine.evaluateActiveTrades(MINT, trade.entryMarketCap * 1.45);
    assert.equal(trade.status, 'PARTIAL_TP_1_4X');
    assert.ok(Math.abs(trade.tokensSold / trade.tokensReceived - 0.75) < 1e-9);
    assert.ok(trade.solReceived > 0);

    // Price falls back: the moonbag trailing stop (20% off the post take profit peak) sells the rest.
    movePrice(1 / 1.7);
    await engine.evaluateActiveTrades(MINT, trade.entryMarketCap * 0.99);
    assert.equal(trade.status, 'CLOSED');
    assert.equal(trade.closeReason, 'TRAILING_STOP_MOONBAG');
    assert.ok(Math.abs(trade.tokensSold - trade.tokensReceived) < 1e-6);
    assert.ok(trade.rentReclaimed > 0);
    assert.ok(realizedPnlSol(trade) > 0, `expected a profit, got ${realizedPnlSol(trade)}`);
    assert.equal(sent.httpPosts, 0);
});

test('losing paper trade: stop loss closes it and the loss is recorded as a loss', async () => {
    await engine.executeTradeLocal(MINT2, 'buy', 0.2, true, 0.0001, 'COPY_TRADE', WHALE);
    const trade = ActiveTrade.docs.find(d => d.mint === MINT2);
    movePrice(0.6);
    await engine.evaluateActiveTrades(MINT2, trade.entryMarketCap * 0.7);
    assert.equal(trade.status, 'CLOSED');
    assert.equal(trade.closeReason, 'STOP_LOSS_28');
    assert.ok(realizedPnlSol(trade) < 0);
    movePrice(1 / 0.6);
});

test('stats report real results: one win, one loss, nothing invented', () => {
    const s = summarizeTrades(ActiveTrade.docs);
    assert.equal(s.measuredCount, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
    assert.equal(s.winRate, 50);
    const expected = ActiveTrade.docs.reduce((sum, t) => sum + realizedPnlSol(t), 0);
    assert.ok(Math.abs(s.totalPnlSol - expected) < 1e-12);
});

test('paper balance tracks realized results', async () => {
    const expected = 1 + ActiveTrade.docs.reduce((sum, t) => sum + realizedPnlSol(t), 0);
    assert.ok(Math.abs((await engine.getPaperBalance()) - expected) < 1e-9);
});

test('a meaningful whale sell mirrors the exit (this used to throw and never sell)', async () => {
    await engine.executeTradeLocal(MINT, 'buy', 0.2, true, 0.0001, 'COPY_TRADE', WHALE);
    const trade = [...ActiveTrade.docs].reverse().find(d => d.mint === MINT);
    assert.equal(trade.status, 'OPEN');
    await engine.reportWhaleSell(
        { mint: MINT, solAmount: 5, tokenAmount: 1000000, marketCapSol: spotMcSol(), signature: 'whaleSellSig1', traderPublicKey: WHALE },
        { walletAddress: WHALE, label: 'netvyxe' }
    );
    assert.equal(trade.status, 'CLOSED');
    assert.equal(trade.closeReason, 'WHALE_MIRROR');
    assert.ok(trade.solReceived > 0);
});

test('a dust whale sell does not dump the position', async () => {
    await engine.executeTradeLocal(MINT2, 'buy', 0.2, true, 0.0001, 'COPY_TRADE', WHALE);
    const trade = [...ActiveTrade.docs].reverse().find(d => d.mint === MINT2);
    await engine.reportWhaleSell(
        { mint: MINT2, solAmount: 0.05, tokenAmount: 10, marketCapSol: spotMcSol(), signature: 'whaleSellSig2', traderPublicKey: WHALE },
        { walletAddress: WHALE, label: 'netvyxe' }
    );
    assert.equal(trade.status, 'OPEN');
});

test('the single position gate only counts trades of the same mode', async () => {
    const open = await ActiveTrade.findOne({ status: { $in: ['OPEN', 'REENTERED'] }, ...engine.modeFilter('live') });
    assert.equal(open, null, 'an open paper trade must not block live trading');
    const paperOpen = await ActiveTrade.findOne({ status: { $in: ['OPEN', 'REENTERED'] }, ...engine.modeFilter('paper') });
    assert.ok(paperOpen);
});
