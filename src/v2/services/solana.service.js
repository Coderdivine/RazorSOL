const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const WatchedWallet = require('../models/WatchedWallet');
const { SOLANA_RPC_URL } = process.env;

class SolanaService {
    constructor() {
        this.connection = new Connection(SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", 'confirmed');
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

    // Direct Solana Blockchain On-Chain Transaction Listener (Fallback & Dual-Engine)
    async watchWalletOnRPC(walletAddress, onBuyCallback) {
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

                console.log(`[SOLANA-RPC] ⚡ Transaction detected for ${walletAddress}! Sig: ${signature}`);
                
                try {
                    // Fetch parsed transaction details
                    const tx = await this.connection.getParsedTransaction(signature, {
                        maxSupportedTransactionVersion: 0,
                        commitment: 'confirmed'
                    });
                    
                    if (!tx || !tx.meta) return;
                    
                    // Identify target wallet index in accounts
                    const accountKeys = tx.transaction.message.accountKeys;
                    const accountIndex = accountKeys.findIndex(
                        a => (a.pubkey ? a.pubkey.toBase58() : a.toBase58()) === walletAddress
                    );
                    
                    if (accountIndex === -1) return;
                    
                    const preSol = (tx.meta.preBalances[accountIndex] || 0) / LAMPORTS_PER_SOL;
                    const postSol = (tx.meta.postBalances[accountIndex] || 0) / LAMPORTS_PER_SOL;
                    const solDiff = preSol - postSol; // Positive if SOL was spent
                    
                    // Check if token balance increased (Buy action)
                    const postTokenBalances = tx.meta.postTokenBalances || [];
                    const preTokenBalances = tx.meta.preTokenBalances || [];
                    
                    const targetTokenGain = postTokenBalances.find(b => {
                        const pre = preTokenBalances.find(p => p.accountIndex === b.accountIndex && p.mint === b.mint);
                        const preAmount = pre ? (pre.uiTokenAmount.uiAmount || 0) : 0;
                        const postAmount = b.uiTokenAmount.uiAmount || 0;
                        return b.owner === walletAddress && postAmount > preAmount;
                    });
                    
                    if (targetTokenGain && solDiff > 0.001) {
                        const mint = targetTokenGain.mint;
                        const spentSol = solDiff;
                        console.log(`[SOLANA-RPC] 🎯 Whale Buy parsed on-chain! Mint: ${mint}, Spent: ${spentSol.toFixed(4)} SOL`);
                        
                        if (typeof onBuyCallback === 'function') {
                            onBuyCallback({
                                txType: 'buy',
                                mint,
                                solAmount: spentSol,
                                traderPublicKey: walletAddress,
                                signature
                            });
                        }
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

    async syncAllWatchedWalletsOnRPC(onBuyCallback) {
        try {
            const wallets = await WatchedWallet.find({ isActive: true });
            console.log(`[SOLANA-RPC] 🔍 Initializing on-chain monitoring for ${wallets.length} watched wallets...`);
            for (let w of wallets) {
                await this.watchWalletOnRPC(w.walletAddress, onBuyCallback);
            }
        } catch (e) {
            console.error('[SOLANA-RPC] ❌ Error syncing watched wallets:', e.message);
        }
    }
}

const service = new SolanaService();
service.startSolPriceTracker();
module.exports = service;
