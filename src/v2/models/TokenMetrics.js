const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TokenMetricsSchema = new Schema(
  {
    mint: {
      type: String,
      required: true,
      unique: true,
    },
    symbol: {
      type: String,
    },
    name: {
      type: String,
    },
    initialMC: {
      type: Number,
    },
    highestMCReached: {
      type: Number,
      default: 0,
    },
    milestonesHit: {
      type: [Number], // e.g. [10000, 20000, 50000]
      default: [],
    },
    devHoldingsPercent: {
      type: Number,
    },
    isRugged: {
      type: Boolean,
      default: false,
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("TokenMetrics", TokenMetricsSchema);
