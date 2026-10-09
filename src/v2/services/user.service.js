require("dotenv").config();
const { SCHEDULE_SECRET } = require("../config");
const User = require("./../models/user.model");
const CustomError = require("./../utils/custom-error");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const uuid = require("uuid");

class UserService {

  generateAccessSignature(hashedPassword) {
    const secretKey = SCHEDULE_SECRET || "default_secret";
    const createdHash = crypto
    .createHmac("sha256", secretKey)
    .update(hashedPassword)
    .digest("hex");
    return createdHash;
  }

  async register(data) {
    if (!data.email) throw new CustomError("Please provide email address");
    const user_id = uuid.v4().toString();
    const hash = await bcrypt.hash(data.password, 10);
    const finEmail = await User.findOne({ email: data.email });
    if (finEmail)
      throw new CustomError("Email already registered");

    if (!data.email.includes("@"))
      throw new CustomError("Please provide a valid email address", 400);
    if (!data.password) throw new CustomError("Please provide a password", 400);

    const razor_id = uuid.v4().toString();
    const accessSignature = this.generateAccessSignature(hash);

    const newUser = new User({
      email: data.email,
      user_id,
      razor_id,
      username: `${data.email.split("@")[0]}` || "",
      password: hash,
      access: accessSignature
    });

    const saved = await newUser.save();
    if (!saved)
      throw new CustomError("Unable to Register user, Please try again");
    
    saved.password = undefined;
    return saved;
  }

  async login(data) {
    const email = data.email;
    const user_data = await User.findOne({ email });
    if (!user_data) throw new CustomError("User not registered", 404);

    const decoded_hash = await bcrypt.compare(
      data.password,
      user_data.password
    );

    if(!user_data.access) {
      const accessSignature = this.generateAccessSignature(user_data.password);
      user_data.access = accessSignature;
      await user_data.save();
    }

    if (!decoded_hash) throw new CustomError("Wrong password", 403);
    
    user_data.password = undefined;
    return user_data;
  }

}

module.exports = new UserService();