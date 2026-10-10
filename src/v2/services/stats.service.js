const ActiveTrade = require('../models/ActiveTrade');
const WatchedWallet = require('../models/WatchedWallet');

class StatsService {
    async getStats() {
        const totalWatched = await WatchedWallet.countDocuments({ isActive: true });
        
        const allTrades = await ActiveTrade.find({});
        const openTrades = allTrades.filter(t => t.status === 'OPEN' || t.status === 'REENTERED' || t.status === 'TP_TAKEN_WAITING_REENTRY');
        const closedTrades = allTrades.filter(t => t.status === 'CLOSED');

        let totalPnlSol = 0;
        let chartLabels = [];
        let chartData = [];
        let runningPnl = 0;

        // Simple PnL calculation based on closed trades
        // In a real app we'd parse exact received SOL vs spent SOL from DB tx records.
        // For now, we simulate the logic based on DB structure.
        closedTrades.forEach((t, i) => {
            // Placeholder: Assume each closed trade was either +100% (TP) or -20% (SL)
            // Real implementation will use exact amounts
            const profit = (t.amountSolInvested || 0) * 0.1; // Dummy profit calculation
            runningPnl += profit;
            totalPnlSol += profit;
            
            chartLabels.push(`T${i+1}`);
            chartData.push(runningPnl.toFixed(2));
        });

        // Generate QuickChart URL
        const chartConfig = {
            type: 'line',
            data: {
                labels: chartLabels.length > 0 ? chartLabels : ['No Trades'],
                datasets: [{
                    label: 'Cumulative PnL (SOL)',
                    data: chartData.length > 0 ? chartData : [0],
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                title: { display: true, text: 'Razor Bot Performance' }
            }
        };

        const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

        return {
            totalWatched,
            totalTrades: allTrades.length,
            openCount: openTrades.length,
            closedCount: closedTrades.length,
            totalPnlSol,
            chartUrl
        };
    }
}

module.exports = new StatsService();
