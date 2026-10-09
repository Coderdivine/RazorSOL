const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const uuid = require("uuid");

const UserSchema = new Schema(
  {
    user_id: {
      type: String,
      required: true,
      default: () => uuid.v4()
    },
    razor_id: {
      type: String,
      default: () => uuid.v4(),
    },
    firstName: {
      type: String,
      default: "No first name",
    },
    lastName: {
      type: String,
      default: "No last name",
    },
    username: {
      type: String,
      default: "No username",
    },
    email: {
      type: String,
      required: true,
    },
    password: {
      type: String,
      required: true,
    },
    access: {
      type: String,
    },
    emailVerified: {
      type: Boolean,
      default: true,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    }
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("razor-user", UserSchema);
