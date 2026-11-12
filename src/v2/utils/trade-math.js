// Pure helpers for sizing, fill parsing and PnL. No network, no database,
// so everything here is covered by unit tests in /test.

const LAMPORTS_PER_SOL = 1e9;
const BASE_FEE_SOL = 0.000005;        // one signature
const TOKEN_ACCOUNT_RENT_SOL = 0.00204; // refundable deposit for a token account
const OPEN_STATUSES = ['OPEN', 'PARTIAL_TP_1_4X', 'PARTIAL_TP_2X', 'REENTERED'];

function keyToString(entry) {
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    if (typeof entry.pubkey === 'string') return entry.pubkey;
    if (entry.pubkey && typeof entry.pubkey.toBase58 === 'function') return entry.pubkey.toBase58();
    if (typeof entry.toBase58 === 'function') return entry.toBase58();
    return String(entry);
}

function uiAmount(tokenBalance) {
    if (!tokenBalance || !tokenBalance.uiTokenAmount) return 0;
    const raw = tokenBalance.uiTokenAmount.uiAmountString ?? tokenBalance.uiTokenAmount.uiAmount ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
}

/**
 * How much SOL to put into the next buy.
 * Leaves room for the worst case fill (slippage), venue fees, the token
 * account deposit and a reserve that pays for the exit.
 */
function computeTradeSize({
    balanceSol,
    fraction = 0.25,
    minTradeSol = 0.05,
    maxTradeSol = 0,
    reserveSol = 0.01,
    slippagePct = 20,
    feePct = 2,
    priorityFeeSol = 0.0001
}) {
    const balance = Number(balanceSol) || 0;
    const fixedCosts = TOKEN_ACCOUNT_RENT_SOL + BASE_FEE_SOL + priorityFeeSol;
    const spendable = balance - reserveSol - fixedCosts;
    if (spendable <= 0) {
        return { sizeSol: 0, reason: `Balance ${balance.toFixed(4)} SOL does not cover the ${reserveSol} SOL reserve plus fees.` };
    }

    const worstCaseMultiplier = 1 + (slippagePct + feePct) / 100;
    let size = balance * fraction;
    if (maxTradeSol > 0) size = Math.min(size, maxTradeSol);
    // Never size a trade whose worst case fill could not be paid for.
    size = Math.min(size, spendable / worstCaseMultiplier);
    size = Math.floor(size * 10000) / 10000;

    if (size < minTradeSol || size <= 0) {
        return {
            sizeSol: 0,
            reason: `Trade size ${size.toFixed(4)} SOL is below the ${minTradeSol} SOL minimum (balance ${balance.toFixed(4)} SOL). Fixed costs would eat the trade.`
        };
    }
    return { sizeSol: size, reason: null };
}

/**
 * Read what one of OUR OWN confirmed transactions actually did to the wallet.
 * Works with web3.js parsed transactions and raw jsonParsed RPC results.
 *
 * solDelta   signed SOL change of the wallet, fees and deposits included
 * tokenDelta signed change of the wallet's balance of `mint`
 * rentSol    deposit paid for token accounts created in this transaction
 */
function parseOwnFill(tx, walletAddress, mint) {
    if (!tx || !tx.meta || !tx.transaction || !tx.transaction.message) return null;
    const keys = tx.transaction.message.accountKeys || [];
    const idx = keys.findIndex(k => keyToString(k) === walletAddress);
    if (idx === -1) return null;

    const pre = tx.meta.preBalances || [];
    const post = tx.meta.postBalances || [];
    const solDelta = ((post[idx] || 0) - (pre[idx] || 0)) / LAMPORTS_PER_SOL;

    const preTok = (tx.meta.preTokenBalances || []).filter(b => b.owner === walletAddress && b.mint === mint);
    const postTok = (tx.meta.postTokenBalances || []).filter(b => b.owner === walletAddress && b.mint === mint);
    const preAmount = preTok.reduce((s, b) => s + uiAmount(b), 0);
    const postAmount = postTok.reduce((s, b) => s + uiAmount(b), 0);

    // Token accounts of ours that did not exist before this transaction.
    const preIdx = new Set(preTok.map(b => b.accountIndex));
    let rentLamports = 0;
    for (const b of postTok) {
        if (!preIdx.has(b.accountIndex) && (pre[b.accountIndex] || 0) === 0) {
            rentLamports += (post[b.accountIndex] || 0);
        }
    }

    return {
        solDelta,
        tokenDelta: postAmount - preAmount,
        feeSol: (tx.meta.fee || 0) / LAMPORTS_PER_SOL,
        rentSol: rentLamports / LAMPORTS_PER_SOL,
        failed: Boolean(tx.meta.err)
    };
}

/** Turn an on chain error (and optional program logs) into one readable line. */
function describeTxError(err, logs = []) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') {
        if (err === 'TIMEOUT_NOT_CONFIRMED') return 'Not confirmed in time (status unknown)';
        return err;
    }
    const text = JSON.stringify(err);
    const logText = Array.isArray(logs) ? logs.join('\n') : '';

    if (/insufficient lamports/i.test(logText) || /insufficient funds/i.test(logText) || /"Custom":1\b/.test(text)) {
        return 'Insufficient SOL for this trade size plus fees (wallet could not cover the fill)';
    }
    if (/"Custom":6002\b/.test(text) || /TooMuchSolRequired/i.test(logText)) {
        return 'Slippage: price moved above the maximum the buy allowed';
    }
    if (/"Custom":6003\b/.test(text) || /TooLittleSolReceived/i.test(logText)) {
        return 'Slippage: price moved below the minimum the sell allowed';
    }
    if (/"Custom":6005\b/.test(text) || /BondingCurveComplete/i.test(logText)) {
        return 'Token left the bonding curve while the trade was in flight';
    }
    if (/BlockhashNotFound/i.test(text)) return 'Blockhash expired before the transaction landed';
    if (/AccountNotFound/i.test(text)) return 'Wallet has no SOL on chain';
    const anchor = logText.match(/Error Message: ([^\n]+)/);
    if (anchor) return anchor[1].trim();
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

/**
 * Model a fill for paper trading. Uses the live price, then applies assumed
 * slippage and fees so paper results are not flattering.
 */
function paperFill({
    action,
    amountSol = 0,
    sellFraction = 1,
    remainingTokens = 0,
    priceSolPerToken,
    slippagePct = 5,
    feePct = 1.5,
    priorityFeeSol = 0.0001,
    chargeRent = true
}) {
    const price = Number(priceSolPerToken);
    if (!Number.isFinite(price) || price <= 0) return null;
    const slip = slippagePct / 100;
    const fee = feePct / 100;

    if (action === 'buy') {
        const fillPrice = price * (1 + slip);
        const tokens = (amountSol * (1 - fee)) / fillPrice;
        const rentSol = chargeRent ? TOKEN_ACCOUNT_RENT_SOL : 0;
        const feeSol = BASE_FEE_SOL + priorityFeeSol;
        return {
            solDelta: -(amountSol + feeSol + rentSol),
            tokenDelta: tokens,
            feeSol,
            rentSol,
            fillPrice
        };
    }

    const tokens = Math.max(0, remainingTokens) * Math.min(1, Math.max(0, sellFraction));
    if (tokens <= 0) return null;
    const fillPrice = price * (1 - slip);
    const feeSol = BASE_FEE_SOL + priorityFeeSol;
    return {
        solDelta: tokens * fillPrice * (1 - fee) - feeSol,
        tokenDelta: -tokens,
        feeSol,
        rentSol: 0,
        fillPrice
    };
}

/**
 * pump.fun bonding curve quotes (constant product on the virtual reserves).
 * virtualSolReserves is in lamports, virtualTokenReserves in raw units (6 decimals).
 * Quoting against the live curve means our own price impact is part of the fill.
 */
const PUMP_TOKEN_DECIMALS = 1e6;

function curveBuyTokens(curve, solIn) {
    const vS = Number(curve && curve.virtualSolReserves);
    const vT = Number(curve && curve.virtualTokenReserves);
    const inLamports = Number(solIn) * LAMPORTS_PER_SOL;
    if (!(vS > 0) || !(vT > 0) || !(inLamports > 0)) return null;
    const tokensOutRaw = vT * (inLamports / (vS + inLamports));
    const tokensOut = tokensOutRaw / PUMP_TOKEN_DECIMALS;
    return { tokensOut, avgPriceSol: Number(solIn) / tokensOut, spotPriceSol: (vS / LAMPORTS_PER_SOL) / (vT / PUMP_TOKEN_DECIMALS) };
}

function curveSellSol(curve, tokensIn) {
    const vS = Number(curve && curve.virtualSolReserves);
    const vT = Number(curve && curve.virtualTokenReserves);
    const inRaw = Number(tokensIn) * PUMP_TOKEN_DECIMALS;
    if (!(vS > 0) || !(vT > 0) || !(inRaw > 0)) return null;
    const solOutLamports = vS * (inRaw / (vT + inRaw));
    return { solOut: solOutLamports / LAMPORTS_PER_SOL };
}

/** "75%" -> 0.75, "100%" -> 1 */
function parseSellFraction(amount) {
    if (typeof amount === 'string' && amount.trim().endsWith('%')) {
        const pct = Number(amount.trim().slice(0, -1));
        if (Number.isFinite(pct)) return Math.min(1, Math.max(0, pct / 100));
    }
    return 1;
}

/** A trade is "measured" once we know what the buy really cost. */
function isMeasured(trade) {
    return Boolean(trade) && Number(trade.solSpent) > 0 && !trade.accountingIncomplete;
}

function realizedPnlSol(trade) {
    return (Number(trade.solReceived) || 0) + (Number(trade.rentReclaimed) || 0) - (Number(trade.solSpent) || 0);
}

/**
 * Real results for a list of trades. Trades without recorded fills are
 * counted separately and never contribute an invented number.
 */
function summarizeTrades(trades) {
    const closed = (trades || []).filter(t => t.status === 'CLOSED');
    const measured = closed.filter(isMeasured);
    let pnl = 0, invested = 0, wins = 0, fees = 0;
    const series = [];
    const sorted = [...measured].sort((a, b) => new Date(a.closedAt || a.createdAt || 0) - new Date(b.closedAt || b.createdAt || 0));
    for (const t of sorted) {
        const p = realizedPnlSol(t);
        pnl += p;
        invested += Number(t.solSpent) || 0;
        fees += Number(t.feesSol) || 0;
        if (p > 0) wins++;
        series.push(pnl);
    }
    return {
        closedCount: closed.length,
        measuredCount: measured.length,
        unmeasuredCount: closed.length - measured.length,
        wins,
        losses: measured.length - wins,
        winRate: measured.length ? (wins / measured.length) * 100 : 0,
        totalPnlSol: pnl,
        totalInvestedSol: invested,
        totalFeesSol: fees,
        roiPct: invested > 0 ? (pnl / invested) * 100 : 0,
        series
    };
}

/** Group results by the wallet that was copied. */
function summarizeByWallet(trades) {
    const groups = new Map();
    for (const t of trades || []) {
        const key = t.mirroredWallet || 'manual';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
    }
    return [...groups.entries()]
        .map(([wallet, list]) => ({
            wallet,
            openCount: list.filter(t => OPEN_STATUSES.includes(t.status)).length,
            ...summarizeTrades(list)
        }))
        .sort((a, b) => b.totalPnlSol - a.totalPnlSol);
}

module.exports = {
    LAMPORTS_PER_SOL,
    BASE_FEE_SOL,
    TOKEN_ACCOUNT_RENT_SOL,
    OPEN_STATUSES,
    computeTradeSize,
    parseOwnFill,
    describeTxError,
    paperFill,
    curveBuyTokens,
    curveSellSol,
    parseSellFraction,
    isMeasured,
    realizedPnlSol,
    summarizeTrades,
    summarizeByWallet
};
