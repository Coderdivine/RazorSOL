const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const WhalePositionSchema = new Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      index: true,
    },
    mint: {
      type: String,
      required: true,
      index: true,
    },
    tokenName: {
      type: String,
      default: "Solana Token",
    },
    tokenSymbol: {
      type: String,
      default: "UNK",
    },
    // Cumulative Buys / Entry Tracking
    totalTokensBought: {
      type: Number,
      default: 0,
    },
    totalSolInvested: {
      type: Number,
      default: 0,
    },
    totalUsdInvested: {
      type: Number,
      default: 0,
    },
    entryMarketCapUSD: {
      type: Number,
      default: 0,
    },
    firstBuyAt: {
      type: Date,
      default: Date.now,
    },
    lastBuyAt: {
      type: Date,
      default: Date.now,
    },
    buyCount: {
      type: Number,
      default: 1,
    },
    // Sells / Realized Performance
    totalTokensSold: {
      type: Number,
      default: 0,
    },
    totalSolRealized: {
      type: Number,
      default: 0,
    },
    totalUsdRealized: {
      type: Number,
      default: 0,
    },
    lastSellAt: {
      type: Date,
    },
    sellCount: {
      type: Number,
      default: 0,
    },
    // Net Gain / ROI Calculations
    netRealizedSolGain: {
      type: Number,
      default: 0,
    },
    netRealizedUsdGain: {
      type: Number,
      default: 0,
    },
    roiPercent: {
      type: Number,
      default: 0,
    },
    isOpen: {
      type: Boolean,
      default: true,
      index: true,
    }
  },
  { timestamps: true }
);

// Fast compound lookup for a whale's active position in a specific mint
WhalePositionSchema.index({ walletAddress: 1, mint: 1, isOpen: 1 });
// Auto-expire old records after 90 days
WhalePositionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model("WhalePosition", WhalePositionSchema);
