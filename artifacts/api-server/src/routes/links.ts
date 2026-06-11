import { Router } from "express";
import { db, patients, careLinks, users, eq, and } from "@workspace/db";
import type { AuthRequest } from "../middlewares/auth";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { ensureLinkCode, generateUniqueLinkCode } from "../lib/linkCode";
import { getManagedPatients } from "../lib/managedPatients";
import * as admin from 'firebase-admin';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/links/my-code
 * Returns (and lazily creates) the link code for the caller's own patient profile.
 */
router.get("/my-code", async (req: AuthRequest, res) => {
  try {
    const patientId = req.user?.linkedPatientId;
    if (!patientId) {
      return res.status(400).json({ error: "You don't have a patient profile to share." });
    }
    const code = await ensureLinkCode(patientId);
    return res.json({ code });
  } catch (error) {
    logger.error({ err: error }, "my-code failed");
    return res.status(500).json({ error: "Failed to get link code" });
  }
});

/**
 * POST /api/links/my-code/reset
 * Regenerates the caller's patient link code (invalidates the old one).
 */
router.post("/my-code/reset", async (req: AuthRequest, res) => {
  try {
    const patientId = req.user?.linkedPatientId;
    if (!patientId) {
      return res.status(400).json({ error: "You don't have a patient profile to share." });
    }
    const code = await generateUniqueLinkCode();
    await db.update(patients)
      .set({ linkCode: code, linkCodeIssuedAt: new Date() })
      .where(eq(patients.id, patientId));
    return res.json({ code });
  } catch (error) {
    logger.error({ err: error }, "my-code reset failed");
    return res.status(500).json({ error: "Failed to reset link code" });
  }
});

/**
 * GET /api/links
 * Lists the patients the caller (family/caregiver) is actively linked to.
 */
router.get("/", async (req: AuthRequest, res) => {
  try {
    const me = req.user!.id;
    const members = await getManagedPatients(me);
    return res.json({ members });
  } catch (error) {
    logger.error({ err: error }, "list links failed");
    return res.status(500).json({ error: "Failed to list linked patients" });
  }
});

/**
 * POST /api/links  { linkCode }
 * Links the caller to a patient by code (instant — knowing the code is consent).
 */
router.post("/", async (req: AuthRequest, res) => {
  try {
    const me = req.user!;
    if (me.role !== "family" && me.role !== "caregiver") {
      return res.status(403).json({ error: "Only family or caregiver accounts can link patients." });
    }

    const raw = (req.body?.linkCode ?? "").toString().trim().toUpperCase();
    if (!raw) return res.status(400).json({ error: "A link code is required." });

    const [patient] = await db.select().from(patients).where(eq(patients.linkCode, raw));
    if (!patient) return res.status(404).json({ error: "INVALID_CODE" });

    if (me.linkedPatientId && me.linkedPatientId === patient.id) {
      return res.status(400).json({ error: "You can't link to your own profile." });
    }

    const relationship = me.role === "caregiver" ? "caregiver" : "family";
    const status = relationship === "caregiver" ? "active" : "pending";

    // Upsert the link
    await db.insert(careLinks)
      .values({ patientId: patient.id, managerId: me.id, relationship, status })
      .onConflictDoUpdate({
        target: [careLinks.patientId, careLinks.managerId],
        set: { status, relationship },
      });

    // Notify the patient
    const [patientUser] = await db.select().from(users).where(eq(users.linkedPatientId, patient.id));
    if (patientUser?.pushToken) {
      try {
        await admin.messaging().send({
          token: patientUser.pushToken,
          notification: {
            title: status === 'active' ? 'New Caregiver Linked' : 'Family Connection Request',
            body: status === 'active' 
              ? `${me.name} is now managing your care.` 
              : `${me.name} wants to connect with your profile. Please approve.`
          },
          data: {
            type: 'link_request',
            managerId: me.id
          }
        });
      } catch (err) {
        logger.error({ err }, "Failed to send link push notification to patient");
      }
    }

    if (status === "active") {
      // Dual-write the legacy single-manager column
      await db.update(patients).set({ caregiverId: me.id }).where(eq(patients.id, patient.id));
    }

    logger.info({ managerId: me.id, patientId: patient.id, relationship, status }, "Patient linked via code");
    return res.json({ 
        success: true, 
        patientId: patient.id, 
        status,
        patient: {
          id: patient.id,
          name: patient.name,
          condition: patient.condition,
          age: patient.age,
        },
    });
  } catch (error) {
    logger.error({ err: error }, "link by code failed");
    return res.status(500).json({ error: "Failed to link patient" });
  }
});

/**
 * DELETE /api/links/:patientId
 * Revokes the caller's link to a patient.
 */
router.delete("/:patientId", async (req: AuthRequest, res) => {
  try {
    const me = req.user!.id;
    const patientId = req.params.patientId as string;

    await db.update(careLinks)
      .set({ status: "revoked" })
      .where(and(eq(careLinks.patientId, patientId), eq(careLinks.managerId, me)));

    // Clear the legacy pointer if it still points at this manager.
    const [patient] = await db.select().from(patients).where(eq(patients.id, patientId));
    if (patient?.caregiverId === me) {
      await db.update(patients).set({ caregiverId: null }).where(eq(patients.id, patientId));
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "revoke link failed");
    return res.status(500).json({ error: "Failed to revoke link" });
  }
});

/**
 * GET /api/links/pending
 * Lists the pending link requests for the caller's patient profile.
 */
router.get("/pending", async (req: AuthRequest, res) => {
  try {
    const patientId = req.user?.linkedPatientId;
    if (!patientId) return res.status(400).json({ error: "No patient profile found." });

    const requests = await db.select({
      id: careLinks.id,
      managerId: careLinks.managerId,
      relationship: careLinks.relationship,
      status: careLinks.status,
      createdAt: careLinks.createdAt,
      managerName: users.name,
      managerEmail: users.email,
    })
    .from(careLinks)
    .innerJoin(users, eq(careLinks.managerId, users.id))
    .where(and(
      eq(careLinks.patientId, patientId),
      eq(careLinks.status, "pending")
    ));

    return res.json({ requests });
  } catch (error) {
    logger.error({ err: error }, "list pending links failed");
    return res.status(500).json({ error: "Failed to list pending link requests" });
  }
});

/**
 * POST /api/links/:managerId/approve
 * Approves a pending link request from a manager (family).
 */
router.post("/:managerId/approve", async (req: AuthRequest, res) => {
  try {
    const patientId = req.user?.linkedPatientId;
    const managerId = req.params.managerId as string;
    if (!patientId) return res.status(400).json({ error: "No patient profile found." });

    await db.update(careLinks)
      .set({ status: "active" })
      .where(and(
        eq(careLinks.patientId, patientId),
        eq(careLinks.managerId, managerId),
        eq(careLinks.status, "pending")
      ));

    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "approve link failed");
    return res.status(500).json({ error: "Failed to approve link" });
  }
});

/**
 * POST /api/links/:managerId/reject
 * Rejects a pending link request from a manager.
 */
router.post("/:managerId/reject", async (req: AuthRequest, res) => {
  try {
    const patientId = req.user?.linkedPatientId;
    const managerId = req.params.managerId as string;
    if (!patientId) return res.status(400).json({ error: "No patient profile found." });

    await db.update(careLinks)
      .set({ status: "rejected" })
      .where(and(
        eq(careLinks.patientId, patientId),
        eq(careLinks.managerId, managerId),
        eq(careLinks.status, "pending")
      ));

    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "reject link failed");
    return res.status(500).json({ error: "Failed to reject link" });
  }
});

export default router;
