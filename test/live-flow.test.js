// The LIVE order path with PumpPortal, the RPC, the database and Telegram
// replaced by fakes. Nothing here touches the network. It checks that a real
// order is sized safely, dry run first, reconciled when confirmation is
// unclear, recorded from the actual fill, and that failures are reported.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

const keypair = Keypair.generate();
const WALLET = keypair.publicKey.toBase58();
process.env.TRADING_MODE = 'live';
process.env.WALLET_PUBLIC_KEY = WALLET;
process.env.WALLET_PRIVATE_KEY = bs58.encode(keypair.secretKey);
process.env.CLOSE_TOKEN_ACCOUNTS = 'false';

const SRC = path.join(__dirname, '..', 'src', 'v2');
const MINT = 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump';
const WHALE = 'HmUt3Jn46j7c7ANdURmEyjSRj8i3Em6MhjQUi37PZ219';
const blockhash = () => Keypair.generate().publicKey.toBase58();

function matches(doc, query) {
    return Object.entries(query || {}).every(([k, cond]) => {
        const v = k === '_id' ? String(doc._id) : doc[k];
        if (cond && typeof cond === 'object') {
            if ('$in' in cond) return cond.$in.includes(v);
            if ('$ne' in cond) return v !== cond.$ne;
        }
        return String(cond) === String(v);
    });
}
const query = (result) => {
    const q = { sort: () => q, lean: () => q, then: (a, b) => Promise.resolve(result).then(a, b), catch: (b) => Promise.resolve(result).catch(b) };
    return q;
};
const docs = [];
let seq = 0;
const ActiveTrade = {
    async create(obj) {
        const doc = { status: 'OPEN', mode: 'live', solSpent: 0, solReceived: 0, tokensSold: 0, feesSol: 0, rentPaid: 0, rentReclaimed: 0, ...obj, _id: `id${++seq}`, createdAt: new Date(), sellSignatures: [] };
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
    aggregate: async () => []
};

/** A real, signable transaction, standing in for what PumpPortal returns. */
function unsignedTxBytes() {
    const msg = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash(),
        instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(WHALE), lamports: 1 })]
    }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(msg).serialize());
}

function fillTx({ solLamports, tokensBefore, tokensAfter, newAccount }) {
    return {
        transaction: { message: { accountKeys: [{ pubkey: WALLET }, { pubkey: 'Ata' }] } },
        meta: {
            err: null,
            fee: 105000,
            preBalances: [1000000000, newAccount ? 0 : 2039280],
            postBalances: [1000000000 + solLamports, 2039280],
            preTokenBalances: newAccount ? [] : [{ accountIndex: 1, owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: String(tokensBefore) } }],
            postTokenBalances: [{ accountIndex: 1, owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: String(tokensAfter) } }]
        }
    };
}

const calls = { post: [], simulate: 0, send: 0, admin: [], alerts: [] };
const rpc = {
    balance: 1,
    tokenBalances: [],          // queue of values returned by getTokenBalance
    sim: { ok: true, err: null, logs: [] },
    confirm: { status: 'confirmed', err: null },
    parsed: null
};
const solanaService = {
    connection: { getAccountInfo: async () => null, onAccountChange() {}, onLogs() {} },
    getSolPriceUSD: () => 100,
    isSolPriceFresh: () => true,
    getTokenSupplySafe: async () => 1e9,
    getSolBalance: async () => rpc.balance,
    getTokenBalance: async () => (rpc.tokenBalances.length ? rpc.tokenBalances.shift() : null),
    getLatestBlockhashSafe: async () => blockhash(),
    simulateSafe: async () => { calls.simulate++; return rpc.sim; },
    sendTransactionSafe: async (tx) => { calls.send++; assert.ok(tx.signatures[0].some(b => b !== 0), 'transaction must be signed'); return 'LiveSig111'; },
    confirmSignature: async () => rpc.confirm,
    fetchParsedTransactionSafe: async () => rpc.parsed,
    closeEmptyTokenAccounts: async () => ({ reclaimedSol: 0 }),
    withFallback(fn) { return fn(this.connection); },
    fetchOnChainMetadata: async () => null
};

function inject(file, exports) {
    const id = require.resolve(file);
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exports;
    require.cache[id] = m;
}
const emptyModel = { findOne: () => query(null), find: () => query([]), findOneAndUpdate: async () => null, create: async () => ({}) };
inject(path.join(SRC, 'models', 'ActiveTrade.js'), ActiveTrade);
inject(path.join(SRC, 'models', 'WhalePosition.js'), emptyModel);
inject(path.join(SRC, 'models', 'TokenMetrics.js'), emptyModel);
inject(path.join(SRC, 'models', 'WatchedWallet.js'), emptyModel);
inject(path.join(SRC, 'models', 'BotSettings.js'), emptyModel);
inject(path.join(SRC, 'services', 'solana.service.js'), solanaService);
inject(path.join(SRC, 'services', 'telegram.service.js'), {
    sendAdminDirectMessage: async (t) => { calls.admin.push(t); },
    sendAlert: (a, g) => { calls.alerts.push({ a, g }); }
});
inject(path.join(SRC, 'services', 'pumpportal.service.js'), { watchToken() {} });
inject('axios', {
    get: async () => ({ data: { pairs: [] } }),
    post: async (url, body) => { calls.post.push(body); return { status: 200, data: unsignedTxBytes() }; }
});

const engine = require(path.join(SRC, 'services', 'trade-engine.service.js'));
const { realizedPnlSol } = require(path.join(SRC, 'utils', 'trade-math.js'));
const reset = () => { calls.post.length = 0; calls.simulate = 0; calls.send = 0; calls.admin.length = 0; calls.alerts.length = 0; };

test('live mode sizes from the real balance and keeps most of it back', async () => {
    assert.equal(engine.cfg.mode, 'live');
    const s = await engine.sizeNextTrade();
    assert.equal(s.balanceSol, 1);
    assert.equal(s.sizeSol, 0.25);
});

test('a live buy is dry run, sent, confirmed and recorded from the actual fill', async () => {
    reset();
    rpc.tokenBalances = [0];
    rpc.parsed = fillTx({ solLamports: -(250000000 + 105000 + 2039280 + 3750000), tokensBefore: 0, tokensAfter: 8000000, newAccount: true });
    const sig = await engine.executeTradeLocal(MINT, 'buy', 0.25, true, 0.0001, 'COPY_TRADE', WHALE);
    assert.equal(sig, 'LiveSig111');
    assert.equal(calls.simulate, 1);
    assert.equal(calls.send, 1);
    assert.equal(calls.post[0].slippage, 20, 'buy slippage comes from config, not the old 35%');
    assert.equal(calls.post[0].amount, 0.25);

    const trade = docs[0];
    assert.equal(trade.mode, 'live');
    assert.equal(trade.buySignature, 'LiveSig111');
    assert.equal(trade.tokensReceived, 8000000);
    assert.ok(Math.abs(trade.solSpent - 0.25589428) < 1e-9, `all in cost ${trade.solSpent}`);
    assert.ok(Math.abs(trade.rentPaid - 0.00203928) < 1e-9);
    // Entry is OUR price: (cost minus refundable deposit) / tokens x supply.
    const expectedEntry = ((0.25589428 - 0.00203928) / 8000000) * 1e9;
    assert.ok(Math.abs(trade.entryMarketCap - expectedEntry) < 1e-6);
    assert.equal(calls.alerts.length, 1, 'a real buy is announced');
});

test('a live sell records what actually came back and closes the trade', async () => {
    reset();
    const trade = docs[0];
    rpc.tokenBalances = [8000000];
    rpc.parsed = fillTx({ solLamports: 300000000, tokensBefore: 8000000, tokensAfter: 0, newAccount: false });
    const sig = await engine.executeTradeLocal(MINT, 'sell', '100%', false, 0.0001, 'STOP_LOSS_28', null, trade._id);
    assert.equal(sig, 'LiveSig111');
    assert.equal(calls.post[0].slippage, 40);
    assert.equal(trade.status, 'CLOSED');
    assert.equal(trade.closeReason, 'STOP_LOSS_28');
    assert.equal(trade.solReceived, 0.3);
    assert.equal(trade.tokensSold, 8000000);
    assert.ok(Math.abs(realizedPnlSol(trade) - (0.3 - 0.25589428)) < 1e-9);
});

test('an order that would fail is caught in the dry run: never sent, no fee, admin told why', async () => {
    reset();
    rpc.tokenBalances = [0];
    rpc.sim = { ok: false, err: { InstructionError: [2, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 100, need 200'] };
    const before = docs.length;
    const sig = await engine.executeTradeLocal(MINT, 'buy', 0.25, true, 0.0001, 'COPY_TRADE', WHALE);
    assert.equal(sig, null);
    assert.equal(calls.send, 0, 'must not broadcast a transaction that fails simulation');
    assert.equal(docs.length, before, 'no trade record for a buy that never happened');
    assert.equal(calls.admin.length, 1);
    assert.match(calls.admin[0], /Insufficient SOL/);
    assert.match(calls.admin[0], /no fee was paid/);
    rpc.sim = { ok: true, err: null, logs: [] };
});

test('a transaction that fails on chain is reported with its reason', async () => {
    reset();
    rpc.tokenBalances = [0];
    rpc.confirm = { status: 'failed', err: { InstructionError: [3, { Custom: 6002 }] } };
    const sig = await engine.executeTradeLocal(MINT, 'buy', 0.25, true, 0.0001, 'COPY_TRADE', WHALE);
    assert.equal(sig, null);
    assert.match(calls.admin[0], /above the maximum/);
    rpc.confirm = { status: 'confirmed', err: null };
});

test('confirmation timeout but tokens arrived: the buy is kept, not abandoned', async () => {
    reset();
    rpc.tokenBalances = [0, 5000000]; // before the order, then after the timeout
    rpc.confirm = { status: 'unknown', err: 'TIMEOUT_NOT_CONFIRMED' };
    rpc.parsed = null; // fill could not be read back either
    const before = docs.length;
    const sig = await engine.executeTradeLocal(MINT, 'buy', 0.25, true, 0.0001, 'COPY_TRADE', WHALE);
    assert.equal(sig, 'LiveSig111');
    assert.equal(docs.length, before + 1, 'position must be tracked so the exit rules manage it');
    const trade = docs[docs.length - 1];
    assert.equal(trade.status, 'OPEN');
    assert.equal(trade.accountingIncomplete, true, 'unreadable fill is excluded from stats instead of guessed');
    trade.status = 'CLOSED';
});

test('confirmation timeout and no tokens: nothing is recorded and the admin is told to check', async () => {
    reset();
    rpc.tokenBalances = [0, 0];
    const before = docs.length;
    const sig = await engine.executeTradeLocal(MINT, 'buy', 0.25, true, 0.0001, 'COPY_TRADE', WHALE);
    assert.equal(sig, null);
    assert.equal(docs.length, before);
    assert.match(calls.admin[0], /Status unknown/);
    rpc.confirm = { status: 'confirmed', err: null };
});

test('a failed balance read is "unknown", never treated as an empty wallet', async () => {
    rpc.balance = null;
    engine.myBalance = 0.8;
    engine.myBalanceUpdatedAt = 0;
    await engine.updateMyBalance();
    assert.equal(engine.myBalance, 0.8);
    await engine.handleBalanceUpdate(null, 'test');
    assert.equal(engine.myBalance, 0.8);
    rpc.balance = 1;
});

test('PumpPortal rejecting the order is reported, not swallowed', async () => {
    reset();
    rpc.tokenBalances = [0];
    const axios = require('axios');
    const realPost = axios.post;
    axios.post = async () => ({ status: 200, data: Buffer.from(JSON.stringify({ error: 'Insufficient liquidity' })) });
    const sig = await engine.executeTradeLocal(MINT, 'buy', 0.25, true, 0.0001, 'COPY_TRADE', WHALE);
    axios.post = realPost;
    assert.equal(sig, null);
    assert.match(calls.admin[0], /PumpPortal rejected the order/);
});
