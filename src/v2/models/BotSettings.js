const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const BotSettingsSchema = new Schema(
  {
    key: {
      type: String,
      default: "global",
      unique: true,
    },
    earlyCADiscoveryEnabled: {
      type: Boolean,
      default: false, // Disabled for now per user request
    },
    watchlistThresholdUSD: {
      type: Number,
      default: 10000, // $10k threshold per user request
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BotSettings", BotSettingsSchema);
