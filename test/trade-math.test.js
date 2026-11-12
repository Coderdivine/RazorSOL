const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/v2/utils/trade-math');
const { loadTradingConfig } = require('../src/v2/config/trading');

const WALLET = 'BotWa11et1111111111111111111111111111111111';
const MINT = 'TokenMint111111111111111111111111111111pump';

test('config defaults to paper mode and only goes live when asked', () => {
    assert.equal(loadTradingConfig({}).mode, 'paper');
    assert.equal(loadTradingConfig({ TRADING_MODE: 'LIVE' }).mode, 'live');
    assert.equal(loadTradingConfig({ TRADING_MODE: 'anything' }).isPaper, true);
    assert.equal(loadTradingConfig({ TRADE_FRACTION: '5' }).tradeFraction, 0.7); // clamped
    assert.equal(loadTradingConfig({ TRADE_FRACTION: '' }).tradeFraction, 0.25);
});

test('sizing never spends the whole wallet', () => {
    const r = m.computeTradeSize({ balanceSol: 1, fraction: 0.25 });
    assert.equal(r.reason, null);
    assert.equal(r.sizeSol, 0.25);
});

test('sizing leaves room for the worst case fill even at a high fraction', () => {
    const balance = 0.5;
    const r = m.computeTradeSize({ balanceSol: balance, fraction: 0.7, slippagePct: 35, feePct: 2, reserveSol: 0.01 });
    const worstCase = r.sizeSol * 1.37 + m.TOKEN_ACCOUNT_RENT_SOL + m.BASE_FEE_SOL + 0.0001 + 0.01;
    assert.ok(r.sizeSol > 0);
    assert.ok(worstCase <= balance + 1e-9, `worst case ${worstCase} exceeds balance`);
});

test('sizing refuses dust trades where fixed costs dominate', () => {
    const r = m.computeTradeSize({ balanceSol: 0.06, fraction: 0.25, minTradeSol: 0.05 });
    assert.equal(r.sizeSol, 0);
    assert.match(r.reason, /below the 0.05 SOL minimum/);
});

test('sizing refuses when the balance cannot cover the reserve', () => {
    const r = m.computeTradeSize({ balanceSol: 0.005, reserveSol: 0.01 });
    assert.equal(r.sizeSol, 0);
    assert.match(r.reason, /reserve/);
});

test('sizing honours the max trade cap', () => {
    const r = m.computeTradeSize({ balanceSol: 10, fraction: 0.5, maxTradeSol: 0.3 });
    assert.equal(r.sizeSol, 0.3);
});

function buyTx() {
    // wallet at index 0, new token account at index 3
    return {
        transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }, 'Other1', 'Other2', 'NewAta'] } },
        meta: {
            err: null,
            fee: 105000,
            preBalances: [500000000, 1, 1, 0],
            postBalances: [500000000 - 100000000 - 105000 - 2039280, 1, 1, 2039280],
            preTokenBalances: [],
            postTokenBalances: [
                { accountIndex: 3, owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: '3500000.5' } },
                { accountIndex: 2, owner: 'SomeoneElse', mint: MINT, uiTokenAmount: { uiAmountString: '999' } }
            ]
        }
    };
}

test('parseOwnFill reads a buy: all in cost, tokens, fee and deposit', () => {
    const f = m.parseOwnFill(buyTx(), WALLET, MINT);
    assert.ok(Math.abs(f.solDelta - (-0.10214428)) < 1e-9);
    assert.equal(f.tokenDelta, 3500000.5);
    assert.equal(f.feeSol, 0.000105);
    assert.equal(f.rentSol, 0.00203928);
    assert.equal(f.failed, false);
});

test('parseOwnFill reads a sell with web3 style PublicKey objects', () => {
    const tx = {
        transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => WALLET } }, { pubkey: { toBase58: () => 'Ata' } }] } },
        meta: {
            err: null,
            fee: 5000,
            preBalances: [10000000, 2039280],
            postBalances: [10000000 + 130000000, 2039280],
            preTokenBalances: [{ accountIndex: 1, owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: '1000' } }],
            postTokenBalances: [{ accountIndex: 1, owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: '250' } }]
        }
    };
    const f = m.parseOwnFill(tx, WALLET, MINT);
    assert.equal(f.solDelta, 0.13);
    assert.equal(f.tokenDelta, -750);
    assert.equal(f.rentSol, 0); // existing account, no new deposit
});

test('parseOwnFill returns null when the wallet is not in the transaction', () => {
    assert.equal(m.parseOwnFill(buyTx(), 'NotThere', MINT), null);
    assert.equal(m.parseOwnFill(null, WALLET, MINT), null);
});

test('describeTxError explains the common failures', () => {
    assert.match(m.describeTxError({ InstructionError: [2, { Custom: 1 }] }), /Insufficient SOL/);
    assert.match(m.describeTxError({ InstructionError: [3, { Custom: 6002 }] }), /above the maximum/);
    assert.match(m.describeTxError({ InstructionError: [3, { Custom: 6003 }] }), /below the minimum/);
    assert.match(m.describeTxError({ InstructionError: [3, { Custom: 6005 }] }), /bonding curve/);
    assert.match(m.describeTxError('TIMEOUT_NOT_CONFIRMED'), /status unknown/);
    assert.match(m.describeTxError({ InstructionError: [0, { Custom: 6001 }] }), /6001/); // unknown codes pass through
    assert.doesNotMatch(m.describeTxError({ InstructionError: [0, { Custom: 6001 }] }), /Insufficient SOL/);
    assert.match(m.describeTxError({ InstructionError: [1, 'X'] }, ['Program log: Error Message: Not enough tokens to sell.']), /Not enough tokens/);
});

test('paper fills are pessimistic: a flat round trip loses money', () => {
    const price = 0.00000003;
    const buy = m.paperFill({ action: 'buy', amountSol: 0.1, priceSolPerToken: price });
    assert.ok(buy.tokenDelta > 0 && buy.solDelta < -0.1);
    const sell = m.paperFill({ action: 'sell', sellFraction: 1, remainingTokens: buy.tokenDelta, priceSolPerToken: price });
    const pnl = sell.solDelta + buy.rentSol + buy.solDelta; // rent comes back when the account is closed
    assert.ok(pnl < 0, 'flat price must not show a profit');
    assert.ok(pnl > -0.02, 'but costs should be in a realistic range');
});

test('paper sell of 75% leaves 25%', () => {
    const sell = m.paperFill({ action: 'sell', sellFraction: m.parseSellFraction('75%'), remainingTokens: 1000, priceSolPerToken: 0.001 });
    assert.equal(sell.tokenDelta, -750);
    assert.equal(m.paperFill({ action: 'sell', remainingTokens: 0, priceSolPerToken: 0.001 }), null);
    assert.equal(m.paperFill({ action: 'buy', amountSol: 1, priceSolPerToken: 0 }), null);
});

test('parseSellFraction', () => {
    assert.equal(m.parseSellFraction('100%'), 1);
    assert.equal(m.parseSellFraction('50%'), 0.5);
    assert.equal(m.parseSellFraction(123), 1);
});

test('stats use real fills only and never invent a profit', () => {
    const trades = [
        { status: 'CLOSED', solSpent: 0.1, solReceived: 0.14, rentReclaimed: 0.002, feesSol: 0.0003, closedAt: '2026-11-01', mirroredWallet: 'A' },
        { status: 'CLOSED', solSpent: 0.1, solReceived: 0.06, rentReclaimed: 0.002, feesSol: 0.0003, closedAt: '2026-11-02', mirroredWallet: 'A' },
        { status: 'CLOSED', amountSolInvested: 0.5, closedAt: '2026-11-03', mirroredWallet: 'B' }, // legacy, no fill data
        { status: 'OPEN', solSpent: 0.1, mirroredWallet: 'B' }
    ];
    const s = m.summarizeTrades(trades);
    assert.equal(s.closedCount, 3);
    assert.equal(s.measuredCount, 2);
    assert.equal(s.unmeasuredCount, 1);
    assert.equal(s.wins, 1);
    assert.equal(s.winRate, 50);
    assert.ok(Math.abs(s.totalPnlSol - 0.004) < 1e-9);
    assert.equal(s.series.length, 2);

    const byWallet = m.summarizeByWallet(trades);
    const a = byWallet.find(w => w.wallet === 'A');
    const b = byWallet.find(w => w.wallet === 'B');
    assert.equal(a.measuredCount, 2);
    assert.equal(b.measuredCount, 0);
    assert.equal(b.openCount, 1);
    assert.equal(b.totalPnlSol, 0);
});
