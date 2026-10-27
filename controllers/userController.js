import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import validator from "validator";
import userModel from "../models/userModel.js";
import otpModel from "../models/otpModel.js";
import doctorModel from "../models/doctorModel.js";
import appointmentModel from "../models/appointmentModel.js";
import { v2 as cloudinary } from "cloudinary";
import stripe from "stripe";
import razorpay from "razorpay";
import nodemailer from "nodemailer";
import { transporter } from "../config/email.js";
import { createHmac, randomInt, timingSafeEqual } from "crypto";

// Gateway Initialize
const stripeInstance = new stripe(process.env.STRIPE_SECRET_KEY);
const razorpayInstance = new razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// API to register user
const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // checking for all data to register user
    if (!name || !email || !password) {
      return res.json({ success: false, message: "Missing Details" });
    }

    // validating email format
    if (!validator.isEmail(email)) {
      return res.json({
        success: false,
        message: "Please enter a valid email",
      });
    }

    // validating strong password
    if (password.length < 8) {
      return res.json({
        success: false,
        message: "Please enter a strong password",
      });
    }

    // hashing user password
    const salt = await bcrypt.genSalt(10); // the more no. round the more time it will take
    const hashedPassword = await bcrypt.hash(password, salt);

    const userData = {
      name,
      email,
      password: hashedPassword,
    };

    const newUser = new userModel(userData);
    const user = await newUser.save();
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);

    res.json({ success: true, token });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// API to login user
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await userModel.findOne({ email });

    if (!user) {
      return res.json({ success: false, message: "User does not exist" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (isMatch) {
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
      res.json({ success: true, token });
    } else {
      res.json({ success: false, message: "Invalid credentials" });
    }
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// API to get user profile data
const getProfile = async (req, res) => {
  try {
    const { userId } = req.body;
    const userData = await userModel.findById(userId).select("-password");

    res.json({ success: true, userData });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// API to update user profile
const updateProfile = async (req, res) => {
  try {
    const { userId, name, phone, address, dob, gender } = req.body;
    const imageFile = req.file;

    if (!name || !phone || !dob || !gender) {
      return res.json({ success: false, message: "Data Missing" });
    }

    await userModel.findByIdAndUpdate(userId, {
      name,
      phone,
      address: JSON.parse(address),
      dob,
      gender,
    });

    if (imageFile) {
      // upload image to cloudinary
      const imageUpload = await cloudinary.uploader.upload(imageFile.path, {
        resource_type: "image",
      });
      const imageURL = imageUpload.secure_url;

      await userModel.findByIdAndUpdate(userId, { image: imageURL });
    }

    res.json({ success: true, message: "Profile Updated" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// API to book appointment
const bookAppointment = async (req, res) => {
  try {
    const { userId, docId, slotDate, slotTime } = req.body;

    if (!userId || !docId || !slotDate || !slotTime) {
      return res
        .status(400)
        .json({ success: false, message: "Select an appointment date and time" });
    }

    const doctor = await doctorModel.findById(docId);

    if (!doctor || !doctor.available) {
      return res.json({
        success: false,
        message: "Doctor not available",
      });
    }

    // check slot availability
    const slotExists = await appointmentModel.findOne({
      docId,
      slotDate,
      slotTime,
      cancelled: false,
    });

    if (slotExists) {
      if (slotExists.userId.toString() === userId.toString()) {
        return res.json({
          success: true,
          message: "Appointment already booked",
          appointmentId: slotExists._id,
        });
      }

      return res.json({
        success: false,
        message: "Slot already booked",
      });
    }

    const user = await userModel.findById(userId).select("_id name email");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User account not found" });
    }

    const appointment = await appointmentModel.create({
      userId,
      docId,
      userData: {
        _id: user._id,
        name: user.name,
        email: user.email,
      },
      docData: {
        _id: doctor._id,
        name: doctor.name,
        image: doctor.image,
        speciality: doctor.speciality,
        address: doctor.address,
      },
      slotDate,
      slotTime,
      amount: doctor.fees,
      date: Date.now(),
      payment: false,
    });

    res.json({
      success: true,
      message: "Appointment booked successfully",
      appointmentId: appointment._id,
    });

  } catch (error) {
    console.error("Book appointment error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to book appointment. Please try again.",
    });
  }
};

// API to cancel appointment
const cancelAppointment = async (req, res) => {
  try {
    const { userId, appointmentId } = req.body;

    const appointmentData = await appointmentModel.findById(appointmentId);

    if (!appointmentData) {
      return res.json({ success: false, message: "Appointment not found" });
    }

    // verify user
    if (appointmentData.userId.toString() !== userId) {
      return res.json({ success: false, message: "Unauthorized action" });
    }

    await appointmentModel.findByIdAndUpdate(appointmentData._id, {
      cancelled: true,
    });

    const { docId, slotDate, slotTime } = appointmentData;

    const doctorData = await doctorModel.findById(docId);
    const userData = await userModel.findById(userId);

    let slots_booked = doctorData.slots_booked || {};

    // SAFE FILTER
    if (slots_booked[slotDate]) {
      slots_booked[slotDate] = slots_booked[slotDate].filter(
        (e) => e !== slotTime,
      );
    }

    await doctorModel.findByIdAndUpdate(docId, { slots_booked });

    /* EMAIL */

    const emailHTML = `
      <h2>Appointment Cancelled</h2>
      <p>Appointment has been cancelled.</p>

      <p><b>Patient:</b> ${userData.name}</p>
      <p><b>Doctor:</b> ${doctorData.name}</p>
      <p><b>Date:</b> ${slotDate}</p>
      <p><b>Time:</b> ${slotTime}</p>
    `;

    await transporter.sendMail({
      from: `"CarePlus Hospital" <${process.env.EMAIL_USER}>`,
      to: userData.email,
      subject: "Appointment Cancelled",
      html: emailHTML,
    });

    await transporter.sendMail({
      from: `"CarePlus Hospital" <${process.env.EMAIL_USER}>`,
      to: process.env.ADMIN_EMAIL,
      subject: "Appointment Cancelled Notification",
      html: emailHTML,
    });

    res.json({ success: true, message: "Appointment Cancelled" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// API to delete appointment

const deleteAppointment = async (req, res) => {
  try {
    const { appointmentId } = req.body;

    const appointment = await appointmentModel.findById(appointmentId);

    if (!appointment) {
      return res.json({ success: false, message: "Appointment not found" });
    }

    if (!appointment.cancelled) {
      return res.json({
        success: false,
        message: "Only cancelled appointments can be deleted",
      });
    }

    await appointmentModel.findByIdAndDelete(appointmentId);

    res.json({ success: true, message: "Appointment deleted" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// API to get user appointments for frontend my-appointments page
const listAppointment = async (req, res) => {
  try {
    const { userId } = req.body;
    const appointments = await appointmentModel.find({ userId });

    res.json({ success: true, appointments });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// API to make payment of appointment using razorpay
const paymentRazorpay = async (req, res) => {
  try {
    const { appointmentId } = req.body;
    const appointmentData = await appointmentModel.findById(appointmentId);

    if (!appointmentData || appointmentData.cancelled) {
      return res.status(404).json({
        success: false,
        message: "Appointment Cancelled or not found",
      });
    }

    if (appointmentData.userId.toString() !== req.body.userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to pay for this appointment",
      });
    }

    if (appointmentData.payment) {
      return res.json({ success: false, message: "Appointment is already paid" });
    }

    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keyId || !keySecret) {
      console.error("Razorpay error: key ID or secret is missing");
      return res.status(503).json({
        success: false,
        message:
          "Razorpay credentials are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the backend environment.",
      });
    }

    if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) {
      console.error("Razorpay error: Key ID does not have a valid Razorpay test/live prefix");
      return res.status(503).json({
        success: false,
        message:
          "Invalid Razorpay Key ID. Copy the Key ID beginning with rzp_test_ or rzp_live_ from the Razorpay Dashboard.",
      });
    }

    const amount = Math.round(appointmentData.amount * 100);
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      process.env.CURRENCY !== "INR"
    ) {
      return res.status(400).json({
        success: false,
        message: "Appointment amount or Razorpay currency is invalid",
      });
    }

    // creating options for razorpay payment
    const options = {
      amount,
      currency: "INR",
      receipt: appointmentData._id.toString(),
    };

    // creation of an order
    const order = await razorpayInstance.orders.create(options);

    return res.json({ success: true, order, keyId });
  } catch (error) {
    console.error(
      "Create Razorpay order error:",
      error instanceof Error ? error.message : error,
    );
    if (error?.statusCode === 401) {
      return res.status(503).json({
        success: false,
        message:
          "Razorpay rejected the configured credentials. Use the matching Key ID and Key Secret from the same Razorpay mode.",
      });
    }
    return res.status(502).json({
      success: false,
      message: "Unable to start Razorpay checkout. Please try again.",
    });
  }
};

// API to verify payment of razorpay
const verifyRazorpay = async (req, res) => {
  try {
    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    } = req.body;

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({
        success: false,
        message: "Razorpay payment details are incomplete",
      });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keySecret) {
      return res.status(503).json({
        success: false,
        message: "Razorpay is not configured correctly",
      });
    }

    const expectedSignature = createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    const providedSignature = Buffer.from(signature, "hex");
    const expectedSignatureBuffer = Buffer.from(expectedSignature, "hex");
    if (
      providedSignature.length !== expectedSignatureBuffer.length ||
      !timingSafeEqual(providedSignature, expectedSignatureBuffer)
    ) {
      return res.status(400).json({
        success: false,
        message: "Razorpay payment signature is invalid",
      });
    }

    const [order, payment] = await Promise.all([
      razorpayInstance.orders.fetch(orderId),
      razorpayInstance.payments.fetch(paymentId),
    ]);

    const appointmentData = await appointmentModel.findById(order.receipt);
    if (
      !appointmentData ||
      appointmentData.cancelled ||
      appointmentData.userId.toString() !== req.body.userId.toString() ||
      order.status !== "paid" ||
      order.currency !== "INR" ||
      order.amount !== Math.round(appointmentData.amount * 100) ||
      payment.order_id !== orderId ||
      payment.status !== "captured" ||
      payment.amount !== order.amount ||
      payment.currency !== order.currency
    ) {
      return res.status(400).json({
        success: false,
        message: "Razorpay payment could not be verified for this appointment",
      });
    }

    await appointmentModel.findByIdAndUpdate(appointmentData._id, {
      payment: true,
    });

    return res.json({ success: true, message: "Payment Successful" });
  } catch (error) {
    console.error(
      "Verify Razorpay payment error:",
      error instanceof Error ? error.message : error,
    );
    if (error?.statusCode === 401) {
      return res.status(503).json({
        success: false,
        message:
          "Razorpay rejected the configured credentials. Check the backend payment keys.",
      });
    }
    return res.status(502).json({
      success: false,
      message:
        "Unable to verify Razorpay payment. Please contact support if you were charged.",
    });
  }
};

// API to make payment of appointment using Stripe
const paymentStripe = async (req, res) => {
  try {
    const { appointmentId } = req.body;
    const { origin } = req.headers;

    const appointmentData = await appointmentModel.findById(appointmentId);

    if (!appointmentData || appointmentData.cancelled) {
      return res.json({
        success: false,
        message: "Appointment Cancelled or not found",
      });
    }

    if (appointmentData.userId.toString() !== req.body.userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to pay for this appointment",
      });
    }

    if (appointmentData.payment) {
      return res.json({ success: false, message: "Appointment is already paid" });
    }

    if (!origin || !process.env.CURRENCY || !Number.isInteger(appointmentData.amount * 100)) {
      return res.status(400).json({
        success: false,
        message: "Payment configuration or appointment amount is invalid",
      });
    }

    const currency = process.env.CURRENCY.toLowerCase();

    const lineItems = [
      {
        price_data: {
          currency,
          product_data: {
            name: "Appointment Fees",
          },
          unit_amount: appointmentData.amount * 100,
        },
        quantity: 1,
      },
    ];

    const session = await stripeInstance.checkout.sessions.create({
      success_url: `${origin}/verify?appointmentId=${appointmentData._id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/verify?success=false&appointmentId=${appointmentData._id}`,
      client_reference_id: appointmentData._id.toString(),
      metadata: {
        appointmentId: appointmentData._id.toString(),
        userId: req.body.userId.toString(),
      },
      line_items: lineItems,
      mode: "payment",
    });

    await appointmentModel.findByIdAndUpdate(appointmentData._id, {
      stripeSessionId: session.id,
    });

    return res.json({ success: true, session_url: session.url });
  } catch (error) {
    console.error(
      "Create Stripe checkout session error:",
      error instanceof Error ? error.message : error,
    );
    if (error?.type === "StripeAuthenticationError" || error?.statusCode === 401) {
      return res.status(503).json({
        success: false,
        message: "Stripe rejected the configured API key. Check the backend Stripe secret key.",
      });
    }
    return res.status(502).json({
      success: false,
      message: "Unable to start Stripe checkout. Please try again.",
    });
  }
};

const verifyStripe = async (req, res) => {
  try {
    const { appointmentId, sessionId } = req.body;

    if (!appointmentId || !sessionId) {
      return res.status(400).json({
        success: false,
        message: "Stripe checkout session details are missing",
      });
    }

    const appointmentData = await appointmentModel.findById(appointmentId);
    if (
      !appointmentData ||
      appointmentData.cancelled ||
      appointmentData.userId.toString() !== req.body.userId.toString() ||
      appointmentData.stripeSessionId !== sessionId
    ) {
      return res.status(400).json({
        success: false,
        message: "Stripe checkout session does not match this appointment",
      });
    }

    const session = await stripeInstance.checkout.sessions.retrieve(sessionId);
    if (
      session.client_reference_id !== appointmentData._id.toString() ||
      session.metadata?.appointmentId !== appointmentData._id.toString() ||
      session.metadata?.userId !== req.body.userId.toString() ||
      session.mode !== "payment" ||
      session.currency !== process.env.CURRENCY.toLowerCase() ||
      session.amount_total !== Math.round(appointmentData.amount * 100)
    ) {
      return res.status(400).json({
        success: false,
        message: "Stripe checkout session does not match this appointment",
      });
    }

    if (session.status !== "complete" || session.payment_status !== "paid") {
      return res.status(409).json({
        success: false,
        message: "Payment was not completed. Please try again or use another payment method.",
      });
    }

    await appointmentModel.findByIdAndUpdate(appointmentData._id, {
      payment: true,
    });
    return res.json({ success: true, message: "Payment Successful" });
  } catch (error) {
    console.error(
      "Verify Stripe payment error:",
      error instanceof Error ? error.message : error,
    );
    return res.status(502).json({
      success: false,
      message: "Unable to verify Stripe payment. Please contact support if you were charged.",
    });
  }
};

const sendOTP = async (req, res) => {
  const email = req.body?.email;
  const normalizedEmail =
    typeof email === "string" ? email.trim().toLowerCase() : "";

  if (!validator.isEmail(normalizedEmail)) {
    return res
      .status(400)
      .json({ success: false, message: "Please enter a valid email" });
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, EMAIL_USER } =
    process.env;
  const port = Number(SMTP_PORT);
  if (
    !SMTP_HOST ||
    !Number.isInteger(port) ||
    port <= 0 ||
    !SMTP_USER ||
    !SMTP_PASS ||
    !EMAIL_USER ||
    !validator.isEmail(EMAIL_USER)
  ) {
    console.error("Send OTP error: SMTP email configuration is incomplete");
    return res
      .status(503)
      .json({ success: false, message: "Email service is not configured" });
  }

  const otp = String(randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  try {
    await otpModel.findOneAndUpdate(
      { email: normalizedEmail },
      { otp, expiresAt },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );

    const emailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: SMTP_SECURE ? SMTP_SECURE === "true" : port === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    await emailTransporter.sendMail({
      from: `"CarePlus Hospital" <${EMAIL_USER}>`,
      to: normalizedEmail,
      subject: "Verify Your Email - CarePlus Hospital",
      html: `
        <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:30px;">
          <div style="max-width:500px; margin:auto; background:white; padding:30px; border-radius:10px; text-align:center; box-shadow:0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color:#2563eb; margin-bottom:10px;">CarePlus Hospital</h2>
            <p style="color:#555; font-size:15px;">Email Verification</p>
            <p style="color:#444; margin-top:20px;">
              Use the following One-Time Password (OTP) to verify your email address.
            </p>
            <div style="font-size:32px; letter-spacing:6px; font-weight:bold; color:#111; background:#f1f5f9; padding:15px 20px; display:inline-block; margin:20px 0; border-radius:8px;">
              ${otp}
            </div>
            <p style="color:#666; font-size:14px;">
              This OTP will expire in <b>5 minutes</b>.
            </p>
            <p style="color:#888; font-size:13px; margin-top:25px;">
              If you did not request this verification, please ignore this email.
            </p>
            <hr style="margin:25px 0; border:none; border-top:1px solid #eee;" />
            <p style="font-size:12px; color:#999;">
              © ${new Date().getFullYear()} CarePlus Hospital. All rights reserved.
            </p>
          </div>
        </div>
      `,
    });

    res.json({ success: true, message: "OTP sent" });

  } catch (error) {
    await otpModel.deleteOne({ email: normalizedEmail, otp }).catch((cleanupError) => {
      console.error(
        "OTP cleanup error:",
        cleanupError instanceof Error ? cleanupError.message : cleanupError,
      );
    });
    console.error(
      "Send OTP error:",
      error instanceof Error ? error.message : error,
    );
    if (error?.code === "EAUTH" || error?.responseCode === 535) {
      return res.status(503).json({
        success: false,
        message: "Email service authentication failed. Check the SMTP credentials.",
      });
    }
    res
      .status(502)
      .json({ success: false, message: "Failed to send OTP. Please try again." });
  }
};

const verifyOTP = async (req, res) => {
  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  const { otp } = req.body ?? {};

  if (!validator.isEmail(email)) {
    return res
      .status(400)
      .json({ success: false, message: "Please enter a valid email" });
  }

  try {
    const verifiedOTP = await otpModel.findOneAndDelete({
      email,
      otp: String(otp),
      expiresAt: { $gt: new Date() },
    });

    if (verifiedOTP) {
      return res.json({ success: true });
    }

    await otpModel.deleteOne({ email, expiresAt: { $lte: new Date() } });
    return res.json({ success: false, message: "OTP is invalid or expired" });
  } catch (error) {
    console.error(
      "Verify OTP error:",
      error instanceof Error ? error.message : error,
    );
    return res
      .status(500)
      .json({ success: false, message: "Unable to verify OTP right now" });
  }
};


const contact = async (req, res) => {
  try {
    const { name, email, message } = req.body;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: email,
      to: process.env.ADMIN_EMAIL,
      subject: "New Contact Form Message",
      html: `
        <h3>New Message</h3>
        <p><b>Name:</b> ${name}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Message:</b> ${message}</p>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({
      success: true,
      message: "Message sent successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to send message",
    });
  }
};

export {
  loginUser,
  registerUser,
  getProfile,
  updateProfile,
  bookAppointment,
  listAppointment,
  cancelAppointment,
  paymentRazorpay,
  verifyRazorpay,
  paymentStripe,
  verifyStripe,
  sendOTP,
  verifyOTP,
  deleteAppointment,
  contact,
};
