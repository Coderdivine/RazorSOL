const ActiveTrade = require('../models/ActiveTrade');
const WatchedWallet = require('../models/WatchedWallet');
const QuickChart = require('quickchart-js');

class StatsService {
    async getStats(timeframe = '1d') {
        let totalWatched = 0;
        try {
            totalWatched = await WatchedWallet.countDocuments({ isActive: true });
        } catch (e) {
            console.warn('[STATS] ⚠️ Could not count watched wallets:', e.message);
        }
        
        // Timeframe filter calculation
        const now = new Date();
        let startTime = new Date(0); // All time by default
        if (timeframe === '1d') {
            startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        } else if (timeframe === '1w') {
            startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        } else if (timeframe === '1m') {
            startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        }

        let allTrades = [];
        try {
            allTrades = await ActiveTrade.find({ createdAt: { $gte: startTime } });
        } catch (e) {
            console.warn('[STATS] ⚠️ Could not fetch active trades:', e.message);
        }

        const openTrades = allTrades.filter(t => t.status === 'OPEN' || t.status === 'REENTERED' || t.status === 'TP_TAKEN_WAITING_REENTRY');
        const closedTrades = allTrades.filter(t => t.status === 'CLOSED');

        let totalPnlSol = 0;
        let chartLabels = [];
        let chartData = [];
        let runningPnl = 0;

        closedTrades.forEach((t, i) => {
            const profit = (t.amountSolInvested || 0) * 0.1;
            runningPnl += profit;
            totalPnlSol += profit;
            
            const dateStr = t.createdAt ? new Date(t.createdAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : `T${i+1}`;
            chartLabels.push(dateStr);
            chartData.push(Number(runningPnl.toFixed(4)));
        });

        if (chartLabels.length === 0) {
            chartLabels = ['Start', 'Current'];
            chartData = [0, 0];
        }

        const timeframeLabel = timeframe === '1d' ? '24 Hours' : timeframe === '1w' ? '7 Days' : '30 Days';

        // Dark-themed modern crypto chart config
        const chartConfig = {
            type: 'line',
            data: {
                labels: chartLabels,
                datasets: [{
                    label: `PnL SOL (${timeframeLabel})`,
                    data: chartData,
                    borderColor: '#10B981',
                    backgroundColor: 'rgba(16, 185, 129, 0.15)',
                    fill: true,
                    tension: 0.35,
                    pointRadius: 4,
                    pointBackgroundColor: '#10B981'
                }]
            },
            options: {
                title: {
                    display: true,
                    text: `RazorSOL - Performance (${timeframeLabel})`,
                    fontColor: '#FFFFFF',
                    fontSize: 16
                },
                legend: {
                    labels: { fontColor: '#9CA3AF' }
                },
                scales: {
                    xAxes: [{
                        ticks: { fontColor: '#9CA3AF' },
                        gridLines: { color: 'rgba(255, 255, 255, 0.05)' }
                    }],
                    yAxes: [{
                        ticks: { fontColor: '#9CA3AF' },
                        gridLines: { color: 'rgba(255, 255, 255, 0.05)' }
                    }]
                }
            }
        };

        const chart = new QuickChart();
        chart.setConfig(chartConfig);
        chart.setWidth(600);
        chart.setHeight(350);
        chart.setBackgroundColor('#111827');

        let chartBuffer = null;
        try {
            chartBuffer = await chart.toBinary();
        } catch (err) {
            console.warn('[STATS] ⚠️ QuickChart toBinary failed:', err.message);
        }

        const chartUrl = chart.getUrl();

        return {
            timeframe,
            timeframeLabel,
            totalWatched,
            totalTrades: allTrades.length,
            openCount: openTrades.length,
            closedCount: closedTrades.length,
            totalPnlSol,
            chartBuffer,
            chartUrl
        };
    }
}

module.exports = new StatsService();
