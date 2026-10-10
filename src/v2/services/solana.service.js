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
}

module.exports = new SolanaService();
