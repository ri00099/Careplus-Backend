import mongoose from "mongoose";

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  otp: { type: String, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

const otpModel = mongoose.models.otp || mongoose.model("otp", otpSchema);
export default otpModel;
