import { Router, Response } from "express";
import { db, users, patients, messages, careLinks } from "@workspace/db";
import { eq, or, and, asc } from "drizzle-orm";
import type { AuthRequest } from "../middlewares/auth";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { PushService } from "../services/pushService";

const router = Router();

// Store active SSE connections mapping userId -> Response object
const clients = new Map<string, Response>();

// ── GET /api/chat/stream ──
// Subscribes a user to Server-Sent Events for incoming messages
router.get("/stream", requireAuth, (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // Send an initial ping to keep connection alive
  res.write(`data: {"type": "connected"}\n\n`);
  
  clients.set(userId, res);
  
  req.on("close", () => {
    clients.delete(userId);
  });
});

// ── GET /api/chat/history/:otherUserId ──
// Fetch chat history between the current user and another user
router.get("/history/:otherUserId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const patientContextId = req.params.otherUserId as string; // from frontend
    
    // Resolve the other user's ID
    let otherUserId: string | null = null;
    if (req.user!.role === "caregiver" || req.user!.role === "family") {
      // Find the user who is linked to this patient
      const [patientUser] = await db.select().from(users).where(eq(users.linkedPatientId, patientContextId));
      if (patientUser) otherUserId = patientUser.id;
    } else {
      // Find the caregiver of this patient
      const [patientRecord] = await db.select().from(patients).where(eq(patients.id, patientContextId));
      if (patientRecord && patientRecord.caregiverId) {
        otherUserId = patientRecord.caregiverId;
      } else {
        // Try care_links table
        const [link] = await db.select().from(careLinks).where(and(eq(careLinks.patientId, patientContextId), eq(careLinks.relationship, "caregiver"), eq(careLinks.status, "active")));
        if (link) {
          otherUserId = link.managerId;
        } else {
          // Fallback: grab the first available caregiver in the system
          const [fallback] = await db.select().from(users).where(eq(users.role, "caregiver"));
          if (fallback) otherUserId = fallback.id;
        }
      }
    }

    if (!otherUserId) {
      return res.json([]);
    }
    
    const history = await db.select()
      .from(messages)
      .where(
        or(
          and(eq(messages.senderId, userId), eq(messages.receiverId, otherUserId)),
          and(eq(messages.senderId, otherUserId), eq(messages.receiverId, userId))
        )
      )
      .orderBy(asc(messages.createdAt));
      
    return res.json(history);
  } catch (err) {
    logger.error({ err }, "Fetch Chat History Error");
    return res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ── POST /api/chat/send ──
router.post("/send", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const senderId = req.user!.id;
    const { patientContextId, text, audioBase64 } = req.body;
    
    if (!text && !audioBase64) {
      return res.status(400).json({ error: "message text or audio is required" });
    }
    if (!patientContextId) {
      return res.status(400).json({ error: "patientContextId is required" });
    }
    
    let receiverId: string | null = null;
    if (req.user!.role === "caregiver" || req.user!.role === "family") {
      const [patientUser] = await db.select().from(users).where(eq(users.linkedPatientId, patientContextId));
      if (patientUser) receiverId = patientUser.id;
    } else {
      const [patientRecord] = await db.select().from(patients).where(eq(patients.id, patientContextId));
      if (patientRecord && patientRecord.caregiverId) {
        receiverId = patientRecord.caregiverId;
      } else {
        const [link] = await db.select().from(careLinks).where(and(eq(careLinks.patientId, patientContextId), eq(careLinks.relationship, "caregiver"), eq(careLinks.status, "active")));
        if (link) {
          receiverId = link.managerId;
        } else {
          // Fallback: grab the first available caregiver
          const [fallback] = await db.select().from(users).where(eq(users.role, "caregiver"));
          if (fallback) receiverId = fallback.id;
        }
      }
    }

    if (!receiverId) {
      return res.status(400).json({ error: "Could not resolve receiver ID from context" });
    }
    
    // Save message to DB
    const [newMessage] = await db.insert(messages).values({
      senderId,
      receiverId,
      patientContextId,
      text: text || "Voice Message",
      audioBase64
    }).returning();
    
    // If the receiver is actively connected via SSE, send it instantly
    const receiverStream = clients.get(receiverId);
    if (receiverStream) {
      receiverStream.write(`data: ${JSON.stringify({ type: "message", data: newMessage })}\n\n`);
    } else {
      // Receiver is offline or backgrounded, send a push notification
      const [receiver] = await db.select().from(users).where(eq(users.id, receiverId));
      if (receiver && receiver.pushToken) {
        await PushService.sendPushNotification(
          receiver.pushToken,
          `New message from ${req.user!.name}`,
          text || "Voice Message",
          { type: "chat", senderId, patientContextId }
        );
      }
    }
    
    return res.json(newMessage);
  } catch (err) {
    logger.error({ err }, "Send Message Error");
    return res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
