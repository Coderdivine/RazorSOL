const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { SOLANA_RPC_URL } = process.env;

class SolanaService {
    constructor() {
        this.connection = new Connection(SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", 'confirmed');
    }

    async getSolBalance(walletAddress) {
        try {
            const pubKey = new PublicKey(walletAddress);
            const balance = await this.connection.getBalance(pubKey);
            return balance / LAMPORTS_PER_SOL;
        } catch (err) {
            console.error("<::: Error fetching balance for", walletAddress, err);
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
}

const service = new SolanaService();
service.startSolPriceTracker();
module.exports = service;
