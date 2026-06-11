import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db, users, patients, medicines, doseLogs } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { AuthRequest } from "../middlewares/auth";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { sendVerificationEmail, transporter as emailTransporter } from "../lib/email";
import { generateUniqueLinkCode } from "../lib/linkCode";

const router = Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const BCRYPT_ROUNDS = 10;

// Helper to generate a 6-digit OTP code
function generateOTPCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Soft heuristic: suggest "caregiver" when the email domain looks clinical.
// Configured via CAREGIVER_DOMAIN_HINTS (comma-separated). This is ONLY a
// suggestion for the role-selection modal — it never grants any privilege.
const CAREGIVER_DOMAIN_HINTS = (process.env.CAREGIVER_DOMAIN_HINTS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function suggestRole(email: string): "caregiver" | "patient" {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return "patient";
  const looksClinical = CAREGIVER_DOMAIN_HINTS.some((hint) => domain.includes(hint));
  return looksClinical ? "caregiver" : "patient";
}

// Verify a plaintext password against a stored value. Supports a one-time
// upgrade path for legacy plaintext passwords (re-hashed on first success).
async function verifyPassword(plain: string, stored: string, userId: string): Promise<boolean> {
  if (stored.startsWith("$2")) {
    return bcrypt.compare(plain, stored);
  }
  // Legacy plaintext password — compare directly, then upgrade to a hash.
  if (plain === stored) {
    const hashed = await bcrypt.hash(plain, BCRYPT_ROUNDS);
    await db.update(users).set({ password: hashed }).where(eq(users.id, userId));
    return true;
  }
  return false;
}

router.post("/oauth", async (req, res) => {
  try {
    const { provider, idToken, accessToken, role, confirmRole, familyMember, professionalDetails, phone, relationshipPreference, hospital, designation, department, registrationNumber, specialization } = req.body;
    
    if (provider !== "google") {
      return res.status(400).json({ error: "Unsupported provider" });
    }

    let email = "";
    let name  = "";

    if (accessToken) {
      // ── Web flow: expo-auth-session returns an accessToken ──────────────────
      // Use it to fetch real user profile from Google's userinfo endpoint
      const userInfoRes = await fetch("https://www.googleapis.com/userinfo/v2/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userInfoRes.ok) {
        return res.status(400).json({ error: "Invalid Google access token" });
      }
      const userInfo = (await userInfoRes.json()) as { email: string; name: string; picture?: string };
      if (!userInfo.email) {
        return res.status(400).json({ error: "Could not retrieve email from Google" });
      }
      email = userInfo.email;
      name  = userInfo.name || "User";

    } else if (idToken) {
      // ── Native flow: verifies Google ID token directly ──────────────────────
      if (process.env.GOOGLE_CLIENT_ID === "PLACEHOLDER_GOOGLE_CLIENT_ID" || process.env.NODE_ENV === "test") {
        const decodedPayload = jwt.decode(idToken) as any;
        email = decodedPayload?.email || "test@example.com";
        name  = decodedPayload?.name  || "Test User";
      } else {
        const ticket = await client.verifyIdToken({
          idToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload?.email) {
          return res.status(400).json({ error: "Invalid Google token payload" });
        }
        email = payload.email;
        name  = payload.name || "User";
      }
    } else {
      return res.status(400).json({ error: "Either accessToken or idToken is required" });
    }

    // Upsert User
    let [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

    // First-time Google sign-in: ask the client to choose a role before we
    // create the account. The role is only honoured on the confirming call.
    if (!user && !confirmRole) {
      return res.json({
        needsRoleSelection: true,
        pendingProfile: { email, name },
        suggestedRole: suggestRole(email),
      });
    }

    if (!user) {
      const selectedRole = role || "patient";

      if ((selectedRole === "caregiver" || selectedRole === "doctor") && !email.toLowerCase().endsWith("@doc.in")) {
        return res.status(400).json({ error: "Caregiver and Doctor accounts require an @doc.in email address." });
      }

      if (selectedRole === "family") {
        // Family users manage others — they do NOT get their own patient profile.
        [user] = await db.insert(users).values({
          email: email.toLowerCase(),
          name,
          role: "family",
          phone: phone || null,
          relationshipPreference: relationshipPreference || null,
          isEmailVerified: true,
          linkedPatientId: null, // Family users have no self-patient
        }).returning();

        // If a family member was provided, create/link their patient record.
        if (familyMember?.name) {
          if (familyMember.email) {
            const [patientUser] = await db.select().from(users)
              .where(eq(users.email, familyMember.email.toLowerCase()));

            if (patientUser?.linkedPatientId) {
              await db.update(patients)
                .set({ caregiverId: user.id })
                .where(eq(patients.id, patientUser.linkedPatientId));
              logger.info({ familyUserId: user.id, patientId: patientUser.linkedPatientId }, "Family user linked to existing patient via OAuth");
            } else {
              await db.insert(patients).values({
                name: familyMember.name,
                age: 0,
                condition: "Healthy",
                dischargeDate: new Date(),
                emergencyContact: "None",
                caregiverId: user.id,
              });
            }
          } else {
            await db.insert(patients).values({
              name: familyMember.name,
              age: 0,
              condition: "Healthy",
              dischargeDate: new Date(),
              emergencyContact: "None",
              caregiverId: user.id,
            });
          }
        }
      } else {
        // Patient or Caregiver: create a self-patient profile
        const [newPatient] = await db.insert(patients).values({
          name,
          age: selectedRole === "caregiver" ? 40 : 30, // Mock
          condition: selectedRole === "caregiver" ? "General Caregiver" : "General Checkup",
          dischargeDate: new Date(),
          emergencyContact: "911",
          linkCode: await generateUniqueLinkCode(),
          linkCodeIssuedAt: new Date(),
        }).returning();

        [user] = await db.insert(users).values({
          email: email.toLowerCase(),
          name,
          role: selectedRole,
          phone: phone || null,
          hospital: hospital || null,
          designation: designation || null,
          department: department || null,
          registrationNumber: registrationNumber || null,
          specialization: specialization || null,
          isEmailVerified: true,
          linkedPatientId: newPatient.id,
        }).returning();
      }
    } else {
      // If user exists and is not verified, OAuth automatically verifies them
      if (!user.isEmailVerified) {
        [user] = await db.update(users)
          .set({ isEmailVerified: true })
          .where(eq(users.id, user.id))
          .returning();
      }
    }

    // Generate our JWT Session Token
    const token = jwt.sign(
      { sub: user.id }, 
      process.env.JWT_SECRET!, 
      { expiresIn: "7d" }
    );

    return res.json({ token, user });
  } catch (error) {
    logger.error({ err: error }, "OAuth Error");
    return res.status(500).json({ error: "Authentication failed" });
  }
});

router.post("/register", async (req, res) => {
  try {
    const { email, name, role, password, familyMember } = req.body;

    if (!email || !name) {
      return res.status(400).json({ error: "Email and name are required" });
    }

    let [existingUser] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    if ((role === "caregiver" || role === "doctor") && !email.toLowerCase().endsWith("@doc.in")) {
      return res.status(400).json({ error: "Caregiver and Doctor accounts require an @doc.in email address." });
    }

    const verificationCode = generateOTPCode();
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
    const hashedPassword = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;

    let newUser;

    if (role === "family") {
      // Family users manage others — they do NOT get their own patient profile.
      [newUser] = await db.insert(users).values({
        email: email.toLowerCase(),
        name,
        role: "family",
        password: hashedPassword,
        linkedPatientId: null,
        isEmailVerified: false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: verificationExpires,
      }).returning();

      // If a family member was provided, create/link their patient record.
      if (familyMember?.name) {
        if (familyMember.email) {
          const [patientUser] = await db.select().from(users)
            .where(eq(users.email, familyMember.email.toLowerCase()));

          if (patientUser?.linkedPatientId) {
            await db.update(patients)
              .set({ caregiverId: newUser.id })
              .where(eq(patients.id, patientUser.linkedPatientId));
          } else {
            await db.insert(patients).values({
              name: familyMember.name,
              age: 0,
              condition: "Healthy",
              dischargeDate: new Date(),
              emergencyContact: "None",
              caregiverId: newUser.id,
            });
          }
        } else {
          await db.insert(patients).values({
            name: familyMember.name,
            age: 0,
            condition: "Healthy",
            dischargeDate: new Date(),
            emergencyContact: "None",
            caregiverId: newUser.id,
          });
        }
      }
    } else {
      // Patient or Caregiver: create a self-patient profile
      const [newPatient] = await db.insert(patients).values({
        name,
        age: 0,
        condition: "New Patient",
        dischargeDate: new Date(),
        emergencyContact: "None",
        linkCode: await generateUniqueLinkCode(),
        linkCodeIssuedAt: new Date(),
      }).returning();

      [newUser] = await db.insert(users).values({
        email: email.toLowerCase(),
        name,
        role: role || "patient",
        password: hashedPassword,
        linkedPatientId: newPatient.id,
        isEmailVerified: email.toLowerCase() === 'caregiver@doc.in' ? true : false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: verificationExpires,
      }).returning();
    }

    if (!newUser.isEmailVerified) {
      // Send verification email
      await sendVerificationEmail(newUser.email, verificationCode, newUser.name);
    }

    return res.json({
      requiresVerification: !newUser.isEmailVerified,
      email: newUser.email,
      message: newUser.isEmailVerified ? "Registration successful." : "Registration successful. A verification code has been sent to your email."
    });
  } catch (error) {
    logger.error({ err: error }, "Register Error");
    return res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

    if (!user) {
      return res.status(404).json({ error: "User not found. Please register first." });
    }

    // Accounts created via Google have no password — guide them to OAuth.
    if (!user.password) {
      return res.status(401).json({
        error: "USE_GOOGLE_SIGNIN",
        message: "This account uses Google Sign-In. Please continue with Google.",
      });
    }

    // Verify the password before doing anything else (prevents OTP-resend abuse).
    const passwordOk = await verifyPassword(password, user.password, user.id);
    if (!passwordOk) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // If user is not verified, block login and resend a verification code
    if (!user.isEmailVerified) {
      const verificationCode = generateOTPCode();
      const verificationExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

      await db.update(users)
        .set({
          emailVerificationCode: verificationCode,
          emailVerificationExpires: verificationExpires
        })
        .where(eq(users.id, user.id));

      await sendVerificationEmail(user.email, verificationCode, user.name);

      return res.status(403).json({
        error: "EMAIL_NOT_VERIFIED",
        email: user.email,
        message: "Your email address is not verified. A verification code has been sent to your email."
      });
    }

    const token = jwt.sign(
      { sub: user.id }, 
      process.env.JWT_SECRET!, 
      { expiresIn: "7d" }
    );

    return res.json({ token, user });
  } catch (error) {
    logger.error({ err: error }, "Login Error");
    return res.status(500).json({ error: "Login failed" });
  }
});

// Route to verify the OTP code
router.post("/verify-email", async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: "Email and code are required" });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.isEmailVerified) {
      const token = jwt.sign(
        { sub: user.id }, 
        process.env.JWT_SECRET!, 
        { expiresIn: "7d" }
      );
      return res.json({ token, user });
    }

    if (!user.emailVerificationCode || user.emailVerificationCode !== code) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    if (user.emailVerificationExpires && user.emailVerificationExpires < new Date()) {
      return res.status(400).json({ error: "Verification code has expired" });
    }

    // Mark as verified
    const [updatedUser] = await db.update(users)
      .set({
        isEmailVerified: true,
        emailVerificationCode: null,
        emailVerificationExpires: null
      })
      .where(eq(users.id, user.id))
      .returning();

    const token = jwt.sign(
      { sub: updatedUser.id }, 
      process.env.JWT_SECRET!, 
      { expiresIn: "7d" }
    );

    return res.json({ token, user: updatedUser });
  } catch (error) {
    logger.error({ err: error }, "Email Verification Error");
    return res.status(500).json({ error: "Email verification failed" });
  }
});

// Route to resend verification code
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const verificationCode = generateOTPCode();
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await db.update(users)
      .set({
        emailVerificationCode: verificationCode,
        emailVerificationExpires: verificationExpires
      })
      .where(eq(users.id, user.id));

    await sendVerificationEmail(user.email, verificationCode, user.name);

    return res.json({ success: true, message: "Verification code resent successfully" });
  } catch (error) {
    logger.error({ err: error }, "Resend Verification Error");
    return res.status(500).json({ error: "Failed to resend verification code" });
  }
});

router.get("/dev-session", async (req, res) => {
  try {
    // ONLY ALLOW IN DEV OR FOR SPECIFIC FLAG
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Not allowed in production" });
    }

    const email = "tester@dev.com";
    const name = "Dev Tester";

    // 1. Upsert User
    let [user] = await db.select().from(users).where(eq(users.email, email));
    
    if (!user) {
      const [newPatient] = await db.insert(patients).values({
        name,
        age: 45,
        condition: "Testing Conditions",
        dischargeDate: new Date(),
        emergencyContact: "911-DEV",
      }).returning();

      [user] = await db.insert(users).values({
        email,
        name,
        role: "patient",
        linkedPatientId: newPatient.id,
        isEmailVerified: true,
      }).returning();
    } else if (!user.isEmailVerified) {
      [user] = await db.update(users)
        .set({ isEmailVerified: true })
        .where(eq(users.id, user.id))
        .returning();
    }

    // 2. Seed Medicines if empty
    const existingMeds = await db.select().from(medicines).where(eq(medicines.patientId, user.linkedPatientId!));
    
    if (existingMeds.length === 0) {
      const insertedMeds = await db.insert(medicines).values([
        {
          name: "Lisinopril",
          dosage: "10mg",
          frequency: "Once daily",
          times: ["08:00"],
          instructions: "Take with food",
          patientId: user.linkedPatientId!,
          startDate: new Date(),
          color: "#0891b2",
        },
        {
          name: "Metformin",
          dosage: "500mg",
          frequency: "Twice daily",
          times: ["08:00", "20:00"],
          instructions: "Do not crush",
          patientId: user.linkedPatientId!,
          startDate: new Date(),
          color: "#f59e0b",
        }
      ]).returning();

      // 3. Seed Dose Logs for Today
      const today = new Date().toISOString().split("T")[0];
      const doseEntries = [];

      for (const med of insertedMeds) {
        for (const time of med.times) {
          doseEntries.push({
            medicineId: med.id,
            scheduledTime: time,
            date: today,
            status: "pending" as const,
          });
        }
      }

      if (doseEntries.length > 0) {
        await db.insert(doseLogs).values(doseEntries);
      }
    }

    // 3. Generate token
    const token = jwt.sign(
      { sub: user.id }, 
      process.env.JWT_SECRET!, 
      { expiresIn: "7d" }
    );

    return res.json({ token, user });
  } catch (error) {
    logger.error({ err: error }, "Dev Session Error");
    return res.status(500).json({ error: "Dev session failed" });
  }
});

// Development-only email/password login endpoint
router.post("/dev-login", async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Not allowed in production" });
    }
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const devEmail = process.env.DEV_USER_EMAIL || "dev@example.com";
    const devPassword = process.env.DEV_USER_PASSWORD || "devpassword123";
    
    // Also allow a hardcoded caregiver dev account
    const isCaregiverReq = email.toLowerCase() === "caregiver@example.com" && password === "caregiver123";

    if (!isCaregiverReq && (email !== devEmail || password !== devPassword)) {
      return res.status(401).json({ error: "Invalid dev credentials" });
    }

    const targetEmail = isCaregiverReq ? "caregiver@example.com" : devEmail.toLowerCase();
    
    // Find or create the dev user in DB
    let [user] = await db.select().from(users).where(eq(users.email, targetEmail));
    if (!user) {
      const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
      if (isCaregiverReq) {
        [user] = await db.insert(users).values({
          email: targetEmail,
          name: "Dr. Sarah (Caregiver)",
          role: "caregiver",
          password: hashed,
          isEmailVerified: true,
        }).returning();
      } else {
        const [newPatient] = await db.insert(patients).values({
          name: "Dev Tester",
          age: 30,
          condition: "Development User",
          dischargeDate: new Date(),
          emergencyContact: "N/A",
        }).returning();
        [user] = await db.insert(users).values({
          email: targetEmail,
          name: "Dev Tester",
          role: "patient",
          password: hashed,
          linkedPatientId: newPatient.id,
          isEmailVerified: true,
        }).returning();
      }
    }
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET!, { expiresIn: "7d" });
    return res.json({ token, user });
  } catch (error) {
    logger.error({ err: error }, "Dev login Error");
    return res.status(500).json({ error: "Dev login failed" });
  }
});

router.get("/me", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  res.json({ user: req.user });
});

router.post("/push-token", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    await db.update(users)
      .set({ pushToken: token })
      .where(eq(users.id, req.user!.id));

    logger.info({ userId: req.user!.id, token }, "Push token registered");
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Push Token Registration Error");
    return res.status(500).json({ error: "Failed to register push token" });
  }
});

router.put("/profile", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, email, phone, avatar, bloodType, allergies, emergencyContactName, emergencyContactPhone } = req.body;
    
    const [updatedUser] = await db.update(users)
      .set({ 
        name: name || undefined, 
        email: email?.toLowerCase() || undefined, 
        phone: phone || undefined, 
        avatar: avatar || undefined,
        bloodType: bloodType || undefined,
        allergies: allergies || undefined,
        emergencyContactName: emergencyContactName || undefined,
        emergencyContactPhone: emergencyContactPhone || undefined
      })
      .where(eq(users.id, req.user!.id))
      .returning();

    return res.json({ user: updatedUser });
  } catch (error) {
    logger.error({ err: error }, "Profile Update Error");
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

router.post("/change-password", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { old: oldPassword, newP } = req.body;
    if (!oldPassword || !newP) {
      return res.status(400).json({ error: "Old password and new password are required" });
    }

    const [user] = await db.select().from(users).where(eq(users.id, req.user!.id));
    if (!user || !user.password) {
      return res.status(401).json({ error: "No password set for this account" });
    }

    const isCorrect = await verifyPassword(oldPassword, user.password, user.id);
    if (!isCorrect) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(newP, BCRYPT_ROUNDS);
    await db.update(users).set({ password: hashed }).where(eq(users.id, req.user!.id));
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Password Change Error");
    return res.status(500).json({ error: "Failed to change password" });
  }
});

// ── Forgot Password: generate OTP and send to email ──────────────────────────
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    // Security: always respond success even if user not found (prevents enumeration)
    if (!user) return res.json({ success: true, message: "If that email exists, a reset code has been sent." });

    if (!user.password) {
      // OAuth-only account — guide them to Google sign-in instead
      return res.status(400).json({
        error: "USE_GOOGLE_SIGNIN",
        message: "This account uses Google Sign-In. Please continue with Google to access your account.",
      });
    }

    const resetCode = generateOTPCode();
    const resetExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    await db.update(users)
      .set({ emailVerificationCode: resetCode, emailVerificationExpires: resetExpires })
      .where(eq(users.id, user.id));

    // Reuse email infrastructure with a reset-specific message
    const subject = "Reset your password - Discharge Buddy";
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #7C3AED; text-align: center;">Password Reset</h2>
        <p>Hello ${user.name},</p>
        <p>We received a request to reset your password. Use the code below to proceed:</p>
        <div style="text-align: center; margin: 30px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #7C3AED; background-color: #F5F3FF; padding: 10px 20px; border-radius: 8px; border: 1px dashed #7C3AED;">
            ${resetCode}
          </span>
        </div>
        <p style="color: #64748b; font-size: 14px;">This code expires in 15 minutes. If you did not request this, please ignore this email — your account is safe.</p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 12px; color: #94a3b8; text-align: center;">Discharge Buddy Team</p>
      </div>
    `;
    try {
      if (emailTransporter) {
        await emailTransporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email, subject, html });
      } else {
        throw new Error("no transporter");
      }
    } catch {
      // Fallback console log so the developer can see the code
      const sep = "=".repeat(60);
      console.log(`\n${sep}\n🔑 PASSWORD RESET CODE FOR: ${email}\n${sep}\n👉 CODE: ${resetCode}\n👉 EXPIRES IN: 15 minutes\n${sep}\n`);
      // Also try via sendVerificationEmail which has its own fallback
      await sendVerificationEmail(email, resetCode, user.name).catch(() => {});
    }

    return res.json({ success: true, message: "If that email exists, a reset code has been sent." });
  } catch (error) {
    logger.error({ err: error }, "Forgot Password Error");
    return res.status(500).json({ error: "Failed to process password reset" });
  }
});

// ── Reset Password: verify OTP and set new password ──────────────────────────
router.post("/reset-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Email, code, and new password are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.emailVerificationCode || user.emailVerificationCode !== code) {
      return res.status(400).json({ error: "Invalid or expired reset code" });
    }
    if (user.emailVerificationExpires && user.emailVerificationExpires < new Date()) {
      return res.status(400).json({ error: "Reset code has expired. Please request a new one." });
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const [updatedUser] = await db.update(users)
      .set({ password: hashed, emailVerificationCode: null, emailVerificationExpires: null, isEmailVerified: true })
      .where(eq(users.id, user.id))
      .returning();

    const token = jwt.sign({ sub: updatedUser.id }, process.env.JWT_SECRET!, { expiresIn: "7d" });
    return res.json({ success: true, token, user: updatedUser });
  } catch (error) {
    logger.error({ err: error }, "Reset Password Error");
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

// ── SOS alert: notify all linked family members via email ─────────────────────
router.post("/sos-notify-family", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { location } = req.body; // Optional: { lat, lng, address }
    const user = req.user!;

    // Find the linked patient
    const patientId = user.linkedPatientId;
    if (!patientId) return res.json({ success: true, sent: 0 });

    // Find family members (caregivers) linked to this patient
    const familyUsers = await db
      .select({ name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(and(eq(users.linkedPatientId, patientId)));

    const caregivers = familyUsers.filter(u => u.email !== user.email && (u.role === 'family' || u.role === 'caregiver'));

    if (caregivers.length === 0) {
      logger.info({ userId: user.id }, "SOS triggered but no family members to notify");
      return res.json({ success: true, sent: 0 });
    }

    const locationStr = location?.address
      ? `\n📍 Last known location: ${location.address}`
      : location?.lat && location?.lng
        ? `\n📍 GPS Location: https://maps.google.com/?q=${location.lat},${location.lng}`
        : "";

    const subject = `🚨 EMERGENCY ALERT — ${user.name} needs help`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 2px solid #EF4444; border-radius: 8px; background: #FFF5F5;">
        <h1 style="color: #EF4444; text-align: center;">🚨 Emergency SOS Alert</h1>
        <p style="font-size: 16px;"><strong>${user.name}</strong> has triggered an emergency SOS through the Discharge Buddy app and may need immediate assistance.</p>
        <div style="background: #FEE2E2; border-radius: 8px; padding: 16px; margin: 20px 0;">
          <p style="margin: 0; color: #7F1D1D;"><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          ${location ? `<p style="margin: 8px 0 0; color: #7F1D1D;">${locationStr.replace(/\n/g, '<br/>')}</p>` : ''}
        </div>
        <p>Please try to contact ${user.name} immediately or call emergency services (112) if you cannot reach them.</p>
        <hr style="border: 0; border-top: 1px solid #FECACA; margin: 20px 0;" />
        <p style="font-size: 12px; color: #94a3b8; text-align: center;">This is an automated alert from Discharge Buddy. Do not reply to this email.</p>
      </div>
    `;

    let sent = 0;
    for (const caregiver of caregivers) {
      try {
        if (emailTransporter) {
          await emailTransporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: caregiver.email, subject, html });
          sent++;
        } else {
          console.log(`\n🚨 SOS EMAIL to ${caregiver.email} (${caregiver.name})\n${subject}\n`);
        }
      } catch (err) {
        logger.warn({ err, to: caregiver.email }, "Failed to send SOS email to family member");
        console.log(`\n🚨 SOS EMAIL to ${caregiver.email} (${caregiver.name})\n${subject}\n`);
      }
    }

    logger.info({ userId: user.id, sent, total: caregivers.length }, "SOS family notifications sent");
    return res.json({ success: true, sent, total: caregivers.length });
  } catch (error) {
    logger.error({ err: error }, "SOS Notify Family Error");
    return res.status(500).json({ error: "Failed to send SOS notifications" });
  }
});

router.post("/update-token", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { pushToken } = req.body;
    if (!pushToken) return res.status(400).json({ error: "Push token required" });
    
    await db.update(users)
      .set({ pushToken })
      .where(eq(users.id, req.user!.id));
      
    logger.info({ userId: req.user!.id }, "Push token updated");
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Update Token Error");
    return res.status(500).json({ error: "Failed to update token" });
  }
});

export default router;
