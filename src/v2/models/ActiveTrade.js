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
    amountSolInvested: {
      type: Number,
      required: true,
    },
    tokensReceived: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["OPEN", "TP_TAKEN_WAITING_REENTRY", "REENTERED", "CLOSED"],
      default: "OPEN",
    },
    source: {
      type: String,
      enum: ["COPY_TRADE", "MILESTONE_SNIPE"],
      required: true,
    },
    mirroredWallet: {
      type: String, // If copied from a watched wallet
    },
    gainFactorUsed: {
      type: Number, // Percentage of our balance used
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ActiveTrade", ActiveTradeSchema);
