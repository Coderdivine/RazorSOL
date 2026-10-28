const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ActiveTradeSchema = new Schema(
  {
    mint: {
      type: String,
      required: true,
    },
    tokenName: {
      type: String,
      default: "Unknown",
    },
    entryPrice: {
      type: Number,
      required: true,
    },
    entryMarketCap: {
      type: Number,
      required: true,
    },
    entryMarketCapUSD: {
      type: Number,
      default: 0,
    },
    amountSolInvested: {
      type: Number,
      required: true,
    },
    tokensReceived: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["OPEN", "PARTIAL_TP_1_4X", "PARTIAL_TP_2X", "TP_TAKEN_WAITING_REENTRY", "REENTERED", "CLOSED"],
      default: "OPEN",
    },
    tp14xExecutedAt: {
      type: Date,
    },
    highestMarketCapPostTP: {
      type: Number,
      default: 0,
    },
    tp2xExecutedAt: {
      type: Date,
    },
    closedAt: {
      type: Date,
    },
    closeReason: {
      type: String,
    },
    source: {
      type: String,
      enum: ["COPY_TRADE", "MILESTONE_SNIPE"],
      required: true,
    },
    mirroredWallet: {
      type: String, // If copied from a watched wallet
    },
    convictionTier: {
      type: String,
      default: "STANDARD",
    },
    priorityFeePaid: {
      type: Number,
      default: 0.0001,
    },
    gainFactorUsed: {
      type: Number, // Percentage of our balance used
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ActiveTrade", ActiveTradeSchema);
