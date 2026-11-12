const ActiveTrade = require('../models/ActiveTrade');
const WatchedWallet = require('../models/WatchedWallet');
const { renderAsync } = require('@resvg/resvg-js');
const { loadTradingConfig } = require('../config/trading');
const { summarizeTrades, summarizeByWallet, OPEN_STATUSES } = require('../utils/trade-math');

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
        let startTime = new Date(0);
        let timeLabels = [];
        if (timeframe === '1d') {
            startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            timeLabels = ['-24h', '-18h', '-12h', '-6h', 'Now'];
        } else if (timeframe === '1w') {
            startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            timeLabels = ['Day 1', 'Day 2', 'Day 4', 'Day 6', 'Current'];
        } else if (timeframe === '1m') {
            startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            timeLabels = ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Current'];
        }

        // Report the mode the bot is running in. Paper and live results are never mixed.
        const mode = loadTradingConfig().mode;
        const modeFilter = mode === 'paper' ? { mode: 'paper' } : { mode: { $ne: 'paper' } };

        let allTrades = [];
        try {
            allTrades = await ActiveTrade.find({ createdAt: { $gte: startTime }, ...modeFilter }).lean();
        } catch (e) {
            console.warn('[STATS] ⚠️ Could not fetch active trades:', e.message);
        }

        const openTrades = allTrades.filter(t => OPEN_STATUSES.includes(t.status) || t.status === 'TP_TAKEN_WAITING_REENTRY');
        const closedTrades = allTrades.filter(t => t.status === 'CLOSED');

        // Every figure below comes from SOL that actually left and re-entered the wallet
        // (or from simulated fills in paper mode). Trades with no recorded fill are counted
        // as "unmeasured" and contribute nothing. No estimates.
        const summary = summarizeTrades(allTrades);
        const totalPnlSol = summary.totalPnlSol;

        const winRate = summary.winRate.toFixed(1);
        const timeframeLabel = timeframe === '1d' ? '24 Hours' : timeframe === '1w' ? '7 Days' : '30 Days';

        // Generate SVG Chart
        const chartBuffer = await this.renderChartSvg({
            timeframeLabel,
            timeLabels,
            totalPnlSol,
            series: summary.series,
            mode
        });

        return {
            timeframe,
            timeframeLabel,
            totalWatched,
            totalTrades: allTrades.length,
            openCount: openTrades.length,
            closedCount: closedTrades.length,
            measuredCount: summary.measuredCount,
            unmeasuredCount: summary.unmeasuredCount,
            wins: summary.wins,
            losses: summary.losses,
            totalInvestedSol: summary.totalInvestedSol,
            totalFeesSol: summary.totalFeesSol,
            roiPct: summary.roiPct,
            mode,
            byWallet: summarizeByWallet(allTrades),
            totalPnlSol,
            winRate,
            chartBuffer
        };
    }

    async renderChartSvg({ timeframeLabel, timeLabels, totalPnlSol, series = [], mode = 'live' }) {
        try {
            // Build dynamic polyline coordinates
            const points = [];
            const width = 800;
            const height = 450;
            const paddingLeft = 80;
            const paddingRight = 80;
            const paddingTop = 120;
            const paddingBottom = 90;
            const plotWidth = width - paddingLeft - paddingRight;
            const plotHeight = height - paddingTop - paddingBottom;

            // Generate points
            const steps = timeLabels.length;
            // Cumulative REAL realized PnL, sampled down to the number of axis labels.
            const values = [];
            if (series.length > 0) {
                const full = [0, ...series];
                for (let i = 0; i < steps; i++) {
                    values.push(full[Math.round((i / (steps - 1)) * (full.length - 1))]);
                }
            } else {
                for (let i = 0; i < steps; i++) values.push(0);
            }

            const minVal = Math.min(0, ...values);
            const maxVal = Math.max(0.1, ...values);
            const valRange = (maxVal - minVal) || 1;

            for (let i = 0; i < steps; i++) {
                const x = paddingLeft + (i / (steps - 1)) * plotWidth;
                const v = values[i];
                const y = paddingTop + plotHeight - ((v - minVal) / valRange) * plotHeight;
                points.push({ x: Math.round(x), y: Math.round(y) });
            }

            const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
            const fillD = `${pathD} L ${points[points.length - 1].x} ${height - paddingBottom} L ${points[0].x} ${height - paddingBottom} Z`;

            const isPositive = totalPnlSol >= 0;
            const themeColor = isPositive ? '#10B981' : '#EF4444';
            const themeGrad = isPositive ? '#10B981' : '#EF4444';

            // Construct institutional dark terminal SVG
            const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#0B0E14" rx="20"/>
  <defs>
    <linearGradient id="areaGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${themeGrad}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${themeGrad}" stop-opacity="0.0"/>
    </linearGradient>
  </defs>

  <!-- Background Grid Lines -->
  <line x1="${paddingLeft}" y1="${paddingTop}" x2="${width - paddingRight}" y2="${paddingTop}" stroke="#1F2937" stroke-width="1" stroke-dasharray="4"/>
  <line x1="${paddingLeft}" y1="${paddingTop + plotHeight * 0.5}" x2="${width - paddingRight}" y2="${paddingTop + plotHeight * 0.5}" stroke="#1F2937" stroke-width="1" stroke-dasharray="4"/>
  <line x1="${paddingLeft}" y1="${height - paddingBottom}" x2="${width - paddingRight}" y2="${height - paddingBottom}" stroke="#374151" stroke-width="2"/>

  <!-- Chart Area and Line -->
  <path d="${fillD}" fill="url(#areaGrad)"/>
  <path d="${pathD}" fill="none" stroke="${themeColor}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Data Points -->
  ${points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="5" fill="${themeColor}" stroke="#0B0E14" stroke-width="2"/>`).join('')}

  <!-- Header Branding -->
  <text x="60" y="52" fill="#FFFFFF" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="22" font-weight="bold">⚡ RAZOR PROTOCOL • PnL PERFORMANCE</text>
  <text x="60" y="82" fill="${themeColor}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="600">● ${mode === 'paper' ? 'PAPER MODE (simulated fills)' : 'Live Mainnet (real fills)'} • ${timeframeLabel} Window</text>

  <!-- Metrics Tag -->
  <rect x="${width - 240}" y="36" width="180" height="48" rx="10" fill="#111827" stroke="#1F2937" stroke-width="1"/>
  <text x="${width - 150}" y="56" fill="#9CA3AF" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="11" text-anchor="middle">NET REALIZED</text>
  <text x="${width - 150}" y="76" fill="${themeColor}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="16" font-weight="bold" text-anchor="middle">${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(4)} SOL</text>

  <!-- Time Axis Labels -->
  ${timeLabels.map((lbl, i) => {
      const x = paddingLeft + (i / (steps - 1)) * plotWidth;
      const isLast = i === steps - 1;
      return `<text x="${x}" y="${height - paddingBottom + 32}" fill="${isLast ? themeColor : '#9CA3AF'}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="13" font-weight="${isLast ? 'bold' : 'normal'}" text-anchor="middle">${lbl}</text>`;
  }).join('')}
</svg>
            `;

            const res = await renderAsync(svg);
            return res.asPng();
        } catch (err) {
            console.error('[STATS] ❌ Error rendering SVG chart:', err.message);
            return null;
        }
    }
}

module.exports = new StatsService();
