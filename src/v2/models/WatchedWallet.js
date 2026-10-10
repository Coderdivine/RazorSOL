const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const WatchedWalletSchema = new Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      unique: true,
    },
    label: {
      type: String,
      default: "Whale Wallet",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    addedBy: {
      type: String, // Telegram user ID
      required: true,
    },
    totalSolBalanceCached: {
      type: Number,
      default: 0,
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("WatchedWallet", WatchedWalletSchema);
