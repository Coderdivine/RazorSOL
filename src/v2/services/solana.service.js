const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const WatchedWallet = require('../models/WatchedWallet');
const { SOLANA_RPC_URL } = process.env;

const BASE_MINTS = new Set([
    'So11111111111111111111111111111111111111112', // WSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  // USDT
]);

class SolanaService {
    constructor() {
        this.rpcUrl = SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
        this.connection = new Connection(this.rpcUrl, 'confirmed');
        this.cachedSolPrice = 150;
        this.activeRpcSubscriptions = new Map();
        this.processedSignatures = new Set();
    }

    async getSolBalance(walletAddress) {
        try {
            const pubKey = new PublicKey(walletAddress);
            const balance = await this.connection.getBalance(pubKey);
            return balance / LAMPORTS_PER_SOL;
        } catch (err) {
            console.error("<::: Error fetching balance for", walletAddress, err.message);
            return 0;
        }
    }

    async startSolPriceTracker() {
        this.cachedSolPrice = 150;
        const fetchPrice = async () => {
            try {
                const axios = require('axios');
                const response = await axios.get('https://price.jup.ag/v6/price?ids=SOL');
                if (response.data && response.data.data && response.data.data.SOL) {
                    this.cachedSolPrice = response.data.data.SOL.price;
                }
            } catch (err) {
                // Silent catch for background task
            }
        };
        await fetchPrice();
        setInterval(fetchPrice, 60000); // Update every 60 seconds
    }

    getSolPriceUSD() {
        return this.cachedSolPrice || 150;
    }

    extractPubkeyString(keyEntry) {
        if (!keyEntry) return '';
        if (typeof keyEntry === 'string') return keyEntry;
        if (typeof keyEntry.pubkey === 'string') return keyEntry.pubkey;
        if (keyEntry.pubkey && typeof keyEntry.pubkey.toBase58 === 'function') {
            return keyEntry.pubkey.toBase58();
        }
        if (typeof keyEntry.toBase58 === 'function') {
            return keyEntry.toBase58();
        }
        return String(keyEntry);
    }

    extractUiTokenAmount(tokenBal) {
        if (!tokenBal || !tokenBal.uiTokenAmount) return 0;
        const val = tokenBal.uiTokenAmount.uiAmountString ?? tokenBal.uiTokenAmount.uiAmount ?? 0;
        const num = Number(val);
        return Number.isFinite(num) ? num : 0;
    }

    // Fetch transaction supporting Legacy, Version 0 (v0), and Version 1 (v1) transactions with retry & RPC fallback
    async fetchParsedTransactionSafe(signature, maxRetries = 3) {
        const endpoints = [this.rpcUrl, 'https://solana-rpc.publicnode.com'].filter(Boolean);
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const tx = await this.connection.getParsedTransaction(signature, {
                    maxSupportedTransactionVersion: 1,
                    commitment: 'confirmed'
                });
                if (tx && tx.meta) {
                    return tx;
                }
            } catch (err) {
                // Ignore web3 connection error and try direct JSON-RPC fallbacks
            }

            // Fallback to direct JSON-RPC on each endpoint (including publicnode)
            for (const ep of endpoints) {
                try {
                    const res = await fetch(ep, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'getTransaction',
                            params: [
                                signature,
                                {
                                    encoding: 'jsonParsed',
                                    commitment: 'confirmed',
                                    maxSupportedTransactionVersion: 1
                                }
                            ]
                        })
                    });
                    const data = await res.json();
                    if (data && data.result && data.result.meta) {
                        return data.result;
                    }
                } catch (rpcErr) {
                    // Try next endpoint
                }
            }

            // Wait briefly before retrying if transaction was not yet indexed
            await new Promise(resolve => setTimeout(resolve, 800 * attempt));
        }
        return null;
    }

    parseWalletTrade(tx, walletAddress, signature) {
        if (!tx || !tx.meta || !tx.transaction || !tx.transaction.message) return null;

        const accountKeys = tx.transaction.message.accountKeys || [];
        const accountIndex = accountKeys.findIndex(
            a => this.extractPubkeyString(a) === walletAddress
        );

        if (accountIndex === -1) return null;

        const preSol = (tx.meta.preBalances?.[accountIndex] || 0) / LAMPORTS_PER_SOL;
        const postSol = (tx.meta.postBalances?.[accountIndex] || 0) / LAMPORTS_PER_SOL;
        const nativeSolDiff = preSol - postSol; // Positive when wallet spent native SOL

        const preTokenBalances = tx.meta.preTokenBalances || [];
        const postTokenBalances = tx.meta.postTokenBalances || [];

        // Check Wrapped SOL (WSOL) balance change for this wallet
        const wsolMint = 'So11111111111111111111111111111111111111112';
        const preWsol = preTokenBalances
            .filter(b => b.owner === walletAddress && b.mint === wsolMint)
            .reduce((sum, b) => sum + this.extractUiTokenAmount(b), 0);
        const postWsol = postTokenBalances
            .filter(b => b.owner === walletAddress && b.mint === wsolMint)
            .reduce((sum, b) => sum + this.extractUiTokenAmount(b), 0);
        const wsolDiff = preWsol - postWsol; // Positive when wallet spent WSOL

        // Check USDC balance change for this wallet
        const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const preUsdc = preTokenBalances
            .filter(b => b.owner === walletAddress && b.mint === usdcMint)
            .reduce((sum, b) => sum + this.extractUiTokenAmount(b), 0);
        const postUsdc = postTokenBalances
            .filter(b => b.owner === walletAddress && b.mint === usdcMint)
            .reduce((sum, b) => sum + this.extractUiTokenAmount(b), 0);
        const usdcDiff = preUsdc - postUsdc; // Positive when wallet spent USDC

        // Check USDT balance change for this wallet
        const usdtMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
        const preUsdt = preTokenBalances
            .filter(b => b.owner === walletAddress && b.mint === usdtMint)
            .reduce((sum, b) => sum + this.extractUiTokenAmount(b), 0);
        const postUsdt = postTokenBalances
            .filter(b => b.owner === walletAddress && b.mint === usdtMint)
            .reduce((sum, b) => sum + this.extractUiTokenAmount(b), 0);
        const usdtDiff = preUsdt - postUsdt; // Positive when wallet spent USDT

        const solPrice = this.getSolPriceUSD();
        const usdSpent = usdcDiff + usdtDiff;
        const solFromUsd = solPrice > 0 ? (usdSpent / solPrice) : 0;
        const totalSolSpent = nativeSolDiff + wsolDiff + solFromUsd;
        const totalLiquidBalanceSol = preSol + preWsol + (solPrice > 0 ? (preUsdc + preUsdt) / solPrice : 0);

        // Collect all non-base token mints touched by this wallet
        const walletMints = new Set();
        preTokenBalances.forEach(b => {
            if (b.owner === walletAddress && b.mint && !BASE_MINTS.has(b.mint)) {
                walletMints.add(b.mint);
            }
        });
        postTokenBalances.forEach(b => {
            if (b.owner === walletAddress && b.mint && !BASE_MINTS.has(b.mint)) {
                walletMints.add(b.mint);
            }
        });

        for (const mint of walletMints) {
            const preAmount = preTokenBalances
                .filter(b => b.owner === walletAddress && b.mint === mint)
                .reduce((sum, b) => sum + this.extractUiTokenAmount(b), 0);
            const postAmount = postTokenBalances
                .filter(b => b.owner === walletAddress && b.mint === mint)
                .reduce((sum, b) => sum + this.extractUiTokenAmount(b), 0);

            const tokenDiff = postAmount - preAmount;

            // BUY: Token balance increased and value was spent (SOL, WSOL, USDC, or USDT)
            if (tokenDiff > 0 && (totalSolSpent > 0.001 || usdSpent > 0.5)) {
                return {
                    txType: 'buy',
                    mint,
                    solAmount: Math.max(0.001, totalSolSpent),
                    usdAmount: usdSpent > 0.5 ? usdSpent : totalSolSpent * solPrice,
                    tokenAmount: tokenDiff,
                    traderPublicKey: walletAddress,
                    traderBalanceSol: Math.max(0.1, totalLiquidBalanceSol),
                    signature
                };
            }

            // SELL: Token balance decreased and value was received
            if (tokenDiff < 0 && (totalSolSpent < -0.001 || usdSpent < -0.5)) {
                return {
                    txType: 'sell',
                    mint,
                    solAmount: Math.abs(totalSolSpent),
                    usdAmount: Math.abs(usdSpent),
                    tokenAmount: Math.abs(tokenDiff),
                    traderPublicKey: walletAddress,
                    traderBalanceSol: Math.max(0.1, totalLiquidBalanceSol),
                    signature
                };
            }
        }

        return null;
    }

    // Direct Solana Blockchain On-Chain Transaction Listener (Fallback & Dual-Engine)
    async watchWalletOnRPC(walletAddress, onTradeCallback) {
        if (this.activeRpcSubscriptions.has(walletAddress)) {
            return; // Already watching on RPC
        }

        try {
            const pubkey = new PublicKey(walletAddress);
            console.log(`[SOLANA-RPC] 👁️ Subscribing directly to Solana blockchain logs for ${walletAddress}...`);
            
            const subId = this.connection.onLogs(pubkey, async (logsContext) => {
                if (logsContext.err) return; // Transaction failed on-chain
                
                const signature = logsContext.signature;
                if (this.processedSignatures.has(signature)) return; // Already handled
                this.processedSignatures.add(signature);
                
                // Cleanup signature cache periodically
                if (this.processedSignatures.size > 5000) {
                    const first = this.processedSignatures.values().next().value;
                    this.processedSignatures.delete(first);
                }

                try {
                    const tx = await this.fetchParsedTransactionSafe(signature);
                    if (!tx) return;

                    const tradeEvent = this.parseWalletTrade(tx, walletAddress, signature);
                    if (!tradeEvent) {
                        const accountKeys = tx.transaction?.message?.accountKeys || [];
                        const isSigner = accountKeys.some(k => k.signer && this.extractPubkeyString(k) === walletAddress);
                        if (!isSigner) {
                            console.log(`[SOLANA-RPC] ℹ️ Ignored passive protocol log for ${walletAddress.substring(0, 4)}...${walletAddress.substring(walletAddress.length - 4)} (Fee distribution / reward / airdrop)`);
                        }
                        return;
                    }

                    console.log(`[SOLANA-RPC] ⚡ Active Whale Trade detected for ${walletAddress}! Sig: ${signature}`);
                    if (tradeEvent.txType === 'buy') {
                        const usdDesc = tradeEvent.usdAmount ? ` (~$${tradeEvent.usdAmount.toFixed(2)} USD)` : '';
                        console.log(`[SOLANA-RPC] 🎯 Whale BUY parsed on-chain! Mint: ${tradeEvent.mint} | Spent: ${tradeEvent.solAmount.toFixed(4)} SOL${usdDesc}`);
                    } else if (tradeEvent.txType === 'sell') {
                        const usdDesc = tradeEvent.usdAmount ? ` (~$${tradeEvent.usdAmount.toFixed(2)} USD)` : '';
                        console.log(`[SOLANA-RPC] 📉 Whale SELL parsed on-chain! Mint: ${tradeEvent.mint} | Received: ${tradeEvent.solAmount.toFixed(4)} SOL${usdDesc}`);
                    }

                    if (typeof onTradeCallback === 'function') {
                        onTradeCallback(tradeEvent);
                    }
                } catch (txErr) {
                    console.warn(`[SOLANA-RPC] ⚠️ Error parsing tx ${signature}:`, txErr.message);
                }
            }, 'confirmed');
            
            this.activeRpcSubscriptions.set(walletAddress, subId);
            console.log(`[SOLANA-RPC] ✅ Active listener attached to ${walletAddress} (Sub ID: ${subId})`);
        } catch (e) {
            console.error(`[SOLANA-RPC] ❌ Failed to attach listener to ${walletAddress}:`, e.message);
        }
    }

    async syncAllWatchedWalletsOnRPC(onTradeCallback) {
        try {
            const wallets = await WatchedWallet.find({ isActive: true });
            console.log(`[SOLANA-RPC] 🔍 Initializing on-chain monitoring for ${wallets.length} watched wallets...`);
            for (let w of wallets) {
                await this.watchWalletOnRPC(w.walletAddress, onTradeCallback);
            }
        } catch (e) {
            console.error('[SOLANA-RPC] ❌ Error syncing watched wallets:', e.message);
        }
    }
}

const service = new SolanaService();
service.startSolPriceTracker();
module.exports = service;
