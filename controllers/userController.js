import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import validator from "validator";
import userModel from "../models/userModel.js";
import doctorModel from "../models/doctorModel.js";
import appointmentModel from "../models/appointmentModel.js";
import { v2 as cloudinary } from "cloudinary";
import stripe from "stripe";
import razorpay from "razorpay";
import nodemailer from "nodemailer";
import { transporter } from "../config/email.js";
import SibApiV3Sdk from "sib-api-v3-sdk";

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

    // check if user already booked this slot
    const existingAppointment = await appointmentModel.findOne({
      userId,
      docId,
      slotDate,
      slotTime,
      cancelled: false,
    });

    if (existingAppointment) {
      return res.json({
        success: false,
        message: "You already booked this appointment",
      });
    }

    const docData = await doctorModel.findById(docId).select("-password");

    if (!docData.available) {
      return res.json({ success: false, message: "Doctor Not Available" });
    }

    let slots_booked = docData.slots_booked;

    if (slots_booked[slotDate]) {
      if (slots_booked[slotDate].includes(slotTime)) {
        return res.json({ success: false, message: "Slot Not Available" });
      }
    }

    const userData = await userModel.findById(userId).select("-password");

    delete docData.slots_booked;

    const appointmentData = {
      userId,
      docId,
      userData,
      docData,
      amount: docData.fees,
      slotDate,
      slotTime,
      payment: false,
      date: Date.now(),
    };

    const newAppointment = new appointmentModel(appointmentData);
    await newAppointment.save();

    const options = {
      amount: docData.fees * 100,
      currency: "INR",
      receipt: newAppointment._id.toString(),
    };

    const order = await razorpayInstance.orders.create(options);

    res.json({
      success: true,
      order,
      appointmentId: newAppointment._id,
    });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
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

    await appointmentModel.findByIdAndUpdate(appointmentId, {
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
      return res.json({
        success: false,
        message: "Appointment Cancelled or not found",
      });
    }

    // creating options for razorpay payment
    const options = {
      amount: appointmentData.amount * 100,
      currency: process.env.CURRENCY,
      receipt: appointmentId,
    };

    // creation of an order
    const order = await razorpayInstance.orders.create(options);

    res.json({ success: true, order });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// API to verify payment of razorpay
const verifyRazorpay = async (req, res) => {
  try {
    const { razorpay_order_id } = req.body;

    const orderInfo = await razorpayInstance.orders.fetch(razorpay_order_id);

    if (orderInfo.status !== "paid") {
      return res.json({ success: false, message: "Payment Failed" });
    }

    const appointmentId = orderInfo.receipt;

    const appointmentData = await appointmentModel.findById(appointmentId);

    const userData = await userModel.findById(appointmentData.userId);
    const docData = await doctorModel.findById(appointmentData.docId);

    await appointmentModel.findByIdAndUpdate(appointmentId, {
      payment: true,
    });

    // Send confirmation email
    await transporter.sendMail({
      from: `"CarePlus Hospital" <${process.env.EMAIL_USER}>`,
      to: userData.email,
      subject: "Appointment Confirmed - CarePlus",
      html: `
        <h2>Appointment Confirmed</h2>
        <p>Your appointment has been successfully booked.</p>

        <p><b>Doctor:</b> ${docData.name}</p>
        <p><b>Date:</b> ${appointmentData.slotDate}</p>
        <p><b>Time:</b> ${appointmentData.slotTime}</p>

        <p>Thank you for choosing CarePlus.</p>
      `,
    });

    res.json({ success: true, message: "Payment Successful" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
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

    const currency = process.env.CURRENCY.toLocaleLowerCase();

    const line_items = [
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
      success_url: `${origin}/verify?success=true&appointmentId=${appointmentData._id}`,
      cancel_url: `${origin}/verify?success=false&appointmentId=${appointmentData._id}`,
      line_items: line_items,
      mode: "payment",
    });

    res.json({ success: true, session_url: session.url });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

const verifyStripe = async (req, res) => {
  try {
    const { appointmentId, success } = req.body;

    if (success === "true") {
      await appointmentModel.findByIdAndUpdate(appointmentId, {
        payment: true,
      });
      return res.json({ success: true, message: "Payment Successful" });
    }

    res.json({ success: false, message: "Payment Failed" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

let storedOTP = "";

const sendOTP = async (req, res) => {
  const { email } = req.body;
  storedOTP = Math.floor(100000 + Math.random() * 900000);

  try {
    const client = SibApiV3Sdk.ApiClient.instance;
    const apiKey = client.authentications["api-key"];
    apiKey.apiKey = process.env.BREVO_API_KEY;

    const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

    await tranEmailApi.sendTransacEmail({
      sender: { email: "ri00089g@gmail.com", name: "CarePlus Hospital" },
      to: [{ email: email }],
      subject: "Verify Your Email - CarePlus Hospital",
      htmlContent: `
        <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:30px;">
          <div style="max-width:500px; margin:auto; background:white; padding:30px; border-radius:10px; text-align:center; box-shadow:0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color:#2563eb; margin-bottom:10px;">CarePlus Hospital</h2>
            <p style="color:#555; font-size:15px;">Email Verification</p>
            <p style="color:#444; margin-top:20px;">
              Use the following One-Time Password (OTP) to verify your email address.
            </p>
            <div style="font-size:32px; letter-spacing:6px; font-weight:bold; color:#111; background:#f1f5f9; padding:15px 20px; display:inline-block; margin:20px 0; border-radius:8px;">
              ${storedOTP}
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
    console.error("Send OTP error:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
};


const sendOTPP = async (req, res) => {
  const { email } = req.body;
  storedOTP = Math.floor(100000 + Math.random() * 900000);

  try {
    // Create transporter using SMTP
    const transporter = nodemailer.createTransport({
      host: "smtp-relay.brevo.com",
      port: 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // Send the mail
    await transporter.sendMail({
      from: `"CarePlus Hospital" <ri00089g@gmail.com>`,
      to: email,
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
              ${storedOTP}
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
    console.error("Send OTP error:", error.message);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
};

const verifyOTP = (req, res) => {
  const { otp } = req.body;

  if (Number(otp) === storedOTP) {
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "Invalid OTP" });
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
