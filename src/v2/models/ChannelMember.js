const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ChannelMemberSchema = new Schema(
  {
    telegramUserId: {
      type: String,
      index: true,
    },
    username: {
      type: String,
      index: true,
    },
    channelId: {
      type: String,
      required: true,
      index: true,
    },
    tier: {
      type: String,
      enum: ["DEMO", "TIER_1_SIGNALS", "TIER_2_BOT", "TIER_3_LIFETIME"],
      default: "DEMO",
    },
    inviteLink: {
      type: String,
      unique: true,
      sparse: true,
    },
    durationHours: {
      type: Number,
      default: 24,
    },
    status: {
      type: String,
      enum: ["PENDING_JOIN", "ACTIVE", "EXPIRED", "REVOKED"],
      default: "PENDING_JOIN",
      index: true,
    },
    joinedAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    kickedAt: {
      type: Date,
    },
    addedByAdmin: {
      type: String,
    },
    notes: {
      type: String,
    }
  },
  { timestamps: true }
);

// Compound index for finding expired active members
ChannelMemberSchema.index({ isActive: 1, expiresAt: 1 });
// Compound index for quick username/userId lookups
ChannelMemberSchema.index({ username: 1, isActive: 1 });

module.exports = mongoose.model("ChannelMember", ChannelMemberSchema);
