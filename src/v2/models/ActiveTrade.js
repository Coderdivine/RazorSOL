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
    isBreakevenArmed: {
      type: Boolean,
      default: false,
    },
    highestRatioSeen: {
      type: Number,
      default: 1.0,
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
      enum: ["COPY_TRADE", "MILESTONE_SNIPE", "MANUAL_BUY_MORE", "MANUAL"],
      required: true,
    },
    // 'live' trades moved real funds. 'paper' trades are simulated fills.
    mode: {
      type: String,
      enum: ["live", "paper"],
      default: "live",
    },
    // ---- Real accounting, read from the confirmed transactions themselves ----
    solSpent: {
      type: Number, // all in SOL that left the wallet on buys (fees and deposit included)
      default: 0,
    },
    solReceived: {
      type: Number, // SOL that came back from sells, net of fees
      default: 0,
    },
    tokensSold: {
      type: Number,
      default: 0,
    },
    feesSol: {
      type: Number, // network + priority fees across every transaction of this trade
      default: 0,
    },
    rentPaid: {
      type: Number, // token account deposit paid on entry
      default: 0,
    },
    rentReclaimed: {
      type: Number, // deposit recovered when the token account was closed
      default: 0,
    },
    entryPriceSol: {
      type: Number, // SOL per token actually paid (deposit excluded)
      default: 0,
    },
    tokenSupply: {
      type: Number,
      default: 0,
    },
    buySignature: {
      type: String,
    },
    // True when a fill could not be read back. Such trades are kept but never counted in PnL stats.
    accountingIncomplete: {
      type: Boolean,
      default: false,
    },
    sellSignatures: {
      type: [String],
      default: [],
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
