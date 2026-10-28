require('dotenv').config();
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const WatchedWallet = require('../models/WatchedWallet');
const { SOLANA_RPC_URL, INFURA_API_KEY, INFURA_SOLANA_RPC_URL, SOLANA_WSS_URL } = process.env;

const BASE_MINTS = new Set([
    'So11111111111111111111111111111111111111112', // WSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  // USDT
]);

class SolanaService {
    constructor() {
        // Use Infura Paid RPC as primary connection whenever configured
        const infuraKey = INFURA_API_KEY || (INFURA_SOLANA_RPC_URL ? INFURA_SOLANA_RPC_URL.split('/').pop() : '');
        this.infuraRpcUrl = INFURA_SOLANA_RPC_URL || (infuraKey ? `https://solana-mainnet.infura.io/v3/${infuraKey}` : null);
        this.rpcUrl = this.infuraRpcUrl || SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

        // WebSocket endpoint: Infura is an HTTP JSON-RPC provider and does NOT support Solana pub/sub WebSocket subscriptions (onLogs, onAccountChange).
        // Without an explicit wsEndpoint, @solana/web3.js attempts to open a WebSocket to Infura, receiving HTTP 200 and throwing "ws error: Unexpected server response: 200".
        // Directing WebSocket subscriptions to a dedicated Solana WSS endpoint resolves this cleanly.
        const defaultWss = "wss://api.mainnet-beta.solana.com";
        this.wsEndpoint = SOLANA_WSS_URL || defaultWss;

        this.connection = new Connection(this.rpcUrl, {
            commitment: 'confirmed',
            wsEndpoint: this.wsEndpoint
        });
        this.infuraConnection = this.infuraRpcUrl ? new Connection(this.infuraRpcUrl, {
            commitment: 'confirmed',
            wsEndpoint: this.wsEndpoint
        }) : this.connection;

        console.log(`[SOLANA-RPC] ⚡ Primary Solana RPC active: ${this.infuraRpcUrl ? 'Infura Paid High-Performance RPC' : this.rpcUrl}`);
        console.log(`[SOLANA-RPC] 🔌 Solana WebSocket endpoint active: ${this.wsEndpoint}`);

        this.cachedSolPrice = 150;
        this.activeRpcSubscriptions = new Map();
        this.processedSignatures = new Set();
    }

    async getSolBalance(walletAddress) {
        try {
            const pubKey = new PublicKey(walletAddress);
            // 1. Try Primary Public Connection
            try {
                const balance = await this.connection.getBalance(pubKey);
                return balance / LAMPORTS_PER_SOL;
            } catch (primaryErr) {
                // 2. Try Secondary Public RPC
                try {
                    const secConn = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
                    const balance = await secConn.getBalance(pubKey);
                    return balance / LAMPORTS_PER_SOL;
                } catch (secErr) {
                    // 3. Dynamic Failover: Infura Paid RPC
                    if (this.infuraConnection) {
                        console.log(`[SOLANA-RPC] 🛡️ Public RPC balance check failed for ${walletAddress}. Dynamic failover engaged: using Infura paid RPC.`);
                        const balance = await this.infuraConnection.getBalance(pubKey);
                        return balance / LAMPORTS_PER_SOL;
                    }
                    throw secErr;
                }
            }
        } catch (err) {
            console.error("<::: Error fetching balance for", walletAddress, err.message);
            return 0;
        }
    }

    async getTokenBalance(walletAddress, mint) {
        if (!walletAddress || !mint) return 0;
        try {
            const pubKey = new PublicKey(walletAddress);
            const mintKey = new PublicKey(mint);
            const accounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, { mint: mintKey });
            if (accounts?.value?.length > 0) {
                const amount = accounts.value[0].account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
                return amount;
            }
        } catch (err) {
            // Non-blocking fallback
        }
        return 0;
    }

    async sendTransactionSafe(tx, options = {}) {
        const defaultOpts = {
            skipPreflight: true,
            preflightCommitment: "confirmed",
            maxRetries: 5
        };
        const sendOpts = { ...defaultOpts, ...options };

        // Dual-Engine Multi-RPC Racing: Broadcast to Infura Paid RPC & Primary RPC simultaneously
        // Whichever validator gets it first will process it; duplicate submissions are deduplicated on-chain by signature.
        const promises = [];

        if (this.infuraConnection) {
            promises.push(
                this.infuraConnection.sendTransaction(tx, sendOpts).catch(err => {
                    console.warn(`[SOLANA-RPC] ⚠️ Infura RPC sendTransaction notice: ${err.message}`);
                    throw err;
                })
            );
        }

        if (this.connection) {
            promises.push(
                this.connection.sendTransaction(tx, sendOpts).catch(err => {
                    console.warn(`[SOLANA-RPC] ⚠️ Primary RPC sendTransaction notice: ${err.message}`);
                    throw err;
                })
            );
        }

        try {
            // Promise.any resolves as soon as ANY RPC endpoint accepts the transaction
            const signature = await Promise.any(promises);
            return signature;
        } catch (multiErr) {
            console.warn(`[SOLANA-RPC] ⚠️ Primary & Infura endpoints failed. Attempting fallback public RPC...`);
            const secConn = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
            return await secConn.sendTransaction(tx, sendOpts);
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

    // Direct On-Chain Token Metadata Resolver (Token-2022 Extensions & Metaplex PDA)
    async fetchOnChainMetadata(mint) {
        if (!mint || typeof mint !== 'string') return null;
        try {
            const mintPubkey = new PublicKey(mint);

            // 1. Try Token-2022 parsed extensions (e.g. Nullmask and other Token-2022 mints)
            try {
                let parsed = null;
                try {
                    parsed = await this.connection.getParsedAccountInfo(mintPubkey);
                } catch {
                    const sec = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
                    parsed = await sec.getParsedAccountInfo(mintPubkey);
                }

                const extensions = parsed?.value?.data?.parsed?.info?.extensions;
                if (Array.isArray(extensions)) {
                    const metaExt = extensions.find(e => e.extension === 'tokenMetadata');
                    if (metaExt && metaExt.state && metaExt.state.name) {
                        const name = (metaExt.state.name || '').replace(/\0/g, '').trim();
                        const symbol = (metaExt.state.symbol || '').replace(/\0/g, '').trim();
                        if (name) {
                            return { name, symbol: symbol || 'SOL' };
                        }
                    }
                }
            } catch (extErr) {
                // Fallback to Metaplex
            }

            // 2. Try Metaplex Metadata PDA (Standard SPL tokens & Pump.fun tokens)
            try {
                const metaplexId = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
                const [pda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('metadata'), metaplexId.toBuffer(), mintPubkey.toBuffer()],
                    metaplexId
                );
                let acc = null;
                try {
                    acc = await this.connection.getAccountInfo(pda);
                } catch {
                    const sec = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
                    acc = await sec.getAccountInfo(pda);
                }

                if (acc && acc.data && acc.data.length > 70) {
                    const data = acc.data;
                    const nameLen = data.readUInt32LE(65);
                    if (nameLen > 0 && nameLen < 100) {
                        const name = data.slice(69, 69 + nameLen).toString('utf8').replace(/\0/g, '').trim();
                        const symbolOffset = 69 + nameLen;
                        const symbolLen = data.readUInt32LE(symbolOffset);
                        const symbol = (symbolLen > 0 && symbolLen < 30)
                            ? data.slice(symbolOffset + 4, symbolOffset + 4 + symbolLen).toString('utf8').replace(/\0/g, '').trim()
                            : '';
                        if (name) {
                            return { name, symbol: symbol || 'SOL' };
                        }
                    }
                }
            } catch (metaErr) {
                // Non-blocking
            }
        } catch (err) {
            console.warn(`[SOLANA-RPC] ⚠️ On-chain metadata lookup error for ${mint}:`, err.message);
        }
        return null;
    }

    // Fetch transaction supporting Legacy, Version 0 (v0), and Version 1 (v1) transactions with retry & RPC fallback
    async fetchParsedTransactionSafe(signature, maxRetries = 3) {
        const publicEndpoints = [this.rpcUrl, 'https://solana-rpc.publicnode.com'].filter(Boolean);
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            // 1. Try web3 connection on primary public RPC
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

            // 2. Fallback to direct JSON-RPC on public endpoints
            for (const ep of publicEndpoints) {
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
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.result && data.result.meta) {
                            return data.result;
                        }
                    }
                } catch (rpcErr) {
                    // Try next public endpoint
                }
            }

            // 3. Dynamic Emergency Fallback: If public RPCs failed, were rate-limited (429), or returned nothing
            if (this.infuraRpcUrl) {
                try {
                    const res = await fetch(this.infuraRpcUrl, {
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
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.result && data.result.meta) {
                            console.log(`[SOLANA-RPC] 🛡️ Public RPC rate-limited/failed. Dynamic failover engaged: parsed tx ${signature.substring(0, 8)}... via Infura paid RPC.`);
                            return data.result;
                        }
                    }
                } catch (infuraErr) {
                    console.warn(`[SOLANA-RPC] ⚠️ Infura RPC fallback attempt ${attempt} error:`, infuraErr.message);
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

    async getTokenSupplySafe(mint) {
        if (!mint || typeof mint !== 'string') return 0;
        if (!this.tokenSupplyCache) this.tokenSupplyCache = new Map();
        if (this.tokenSupplyCache.has(mint)) return this.tokenSupplyCache.get(mint);

        try {
            const supplyRes = await this.connection.getTokenSupply(new PublicKey(mint));
            const uiAmount = supplyRes?.value?.uiAmount || 0;
            if (uiAmount > 0) {
                this.tokenSupplyCache.set(mint, uiAmount);
                return uiAmount;
            }
        } catch (e) {
            // Non-blocking fallback
        }
        return 1_000_000_000; // Standard 1B supply for Solana launchpad tokens
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

                    // Compute execution market cap based on on-chain token supply
                    if (tradeEvent.tokenAmount > 0 && tradeEvent.solAmount > 0) {
                        try {
                            const supply = await this.getTokenSupplySafe(tradeEvent.mint);
                            if (supply > 0) {
                                const pricePerToken = tradeEvent.solAmount / tradeEvent.tokenAmount;
                                tradeEvent.marketCapSol = pricePerToken * supply;
                            }
                        } catch (supErr) {
                            // Non-blocking
                        }
                    }

                    console.log(`[SOLANA-RPC] ⚡ Active Whale Trade detected for ${walletAddress}! Sig: ${signature}`);
                    const mcLog = tradeEvent.marketCapSol ? ` | MC: ${(tradeEvent.marketCapSol * this.getSolPriceUSD()).toFixed(0)} USD` : '';
                    if (tradeEvent.txType === 'buy') {
                        const usdDesc = tradeEvent.usdAmount ? ` (~$${tradeEvent.usdAmount.toFixed(2)} USD)` : '';
                        console.log(`[SOLANA-RPC] 🎯 Whale BUY parsed on-chain! Mint: ${tradeEvent.mint} | Spent: ${tradeEvent.solAmount.toFixed(4)} SOL${usdDesc}${mcLog}`);
                    } else if (tradeEvent.txType === 'sell') {
                        const usdDesc = tradeEvent.usdAmount ? ` (~$${tradeEvent.usdAmount.toFixed(2)} USD)` : '';
                        console.log(`[SOLANA-RPC] 📉 Whale SELL parsed on-chain! Mint: ${tradeEvent.mint} | Received: ${tradeEvent.solAmount.toFixed(4)} SOL${usdDesc}${mcLog}`);
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
