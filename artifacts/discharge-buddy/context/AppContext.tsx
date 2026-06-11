import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { Language, LOCALE_BY_LANG } from "@/constants/translations";
import { MockProvider } from "./MockProvider";
import { ApiProvider } from "./ApiProvider";
import type { IDataProvider } from "./types";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { router } from "expo-router";
import { scheduleMedicineNotifications, requestNotificationPermissions, getDevicePushToken } from "@/utils/NotificationHelper";
import { NotificationToast } from "@/components/NotificationToast";
import { soundHelper } from "@/utils/SoundHelper";
import { clearHistory as clearConversationHistory } from "@/utils/conversationMemory";
import { Audio } from "expo-av";
import { cacheDirectory, writeAsStringAsync, EncodingType } from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";
import { getApiUrl } from "@/utils/apiUrl";
import { useConnectivity } from "@/hooks/useConnectivity";

export type UserRole = "patient" | "caregiver" | "family" | null;
// Language type imported from translations.ts

export interface Medicine {
  id: string;
  name: string;
  dosage: string;
  frequency: string;
  times: string[];
  instructions: string;
  simplifiedInstructions: string;
  startDate: string;
  endDate?: string;
  color: string;
  totalPills?: number;
}

export interface DoseLog {
  id: string;
  medicineId: string;
  medicineName: string;
  scheduledTime: string;
  takenAt?: string;
  status: "taken" | "missed" | "pending" | "snoozed";
  date: string;
}

export interface SymptomLog {
  id: string;
  date: string;
  symptoms: string[];
  severity: number;
  notes: string;
  riskLevel: "low" | "medium" | "high";
}

export interface FollowUp {
  id: string;
  title: string;
  doctorName: string;
  dateTime: string;
  location: string;
  notes: string;
  completed: boolean;
}

export interface Patient {
  id: string;
  name: string;
  age: number;
  condition: string;
  dischargeDate: string;
  medicines?: Medicine[];
  doseLogs?: DoseLog[];
  symptomLogs?: SymptomLog[];
  followUps?: FollowUp[];
  emergencyContact: string;
  riskScore?: number;
  riskLevel?: "Low" | "Moderate" | "High";
  caregiverId?: string;
  createdAt?: string;
  // Extended family mock fields
  relation?: string;
  avatar?: string;
  bloodGroup?: string;
  weight?: string;
  height?: string;
  doctor?: string;
  lastVisit?: string;
  nextVisit?: string;
  healthLogs?: { bp?: string; sugar?: string; weight?: string; date: string };
}

// ─── Rich mock data used when family API is unavailable ───────────────────────
export const MOCK_FAMILY_MEMBERS: Patient[] = [
  {
    id: "mock-1",
    name: "Rajesh Sharma",
    age: 58,
    relation: "Father",
    condition: "Diabetes, Hypertension",
    dischargeDate: "2024-05-01",
    emergencyContact: "9876543210",
    bloodGroup: "A+",
    weight: "70 kg",
    height: "5'8\"",
    doctor: "Dr. Vivek Mehta",
    lastVisit: "20 May 2024",
    nextVisit: "30 May 2024",
    riskScore: 42,
    riskLevel: "Moderate",
    healthLogs: { bp: "128/80", sugar: "110 mg/dL", weight: "70 kg", date: "18 May 2024" },
    medicines: [
      { id: "m1", name: "Metformin 500mg", dosage: "500mg", frequency: "daily", times: ["09:00"], instructions: "After Breakfast", simplifiedInstructions: "After Breakfast", startDate: "2024-05-01", color: "#6C47FF" },
      { id: "m2", name: "Amlodipine 5mg",  dosage: "5mg",   frequency: "daily", times: ["14:00"], instructions: "After Lunch",     simplifiedInstructions: "After Lunch",     startDate: "2024-05-01", color: "#3B82F6" },
      { id: "m3", name: "Atorvastatin 10mg",dosage: "10mg", frequency: "daily", times: ["21:00"], instructions: "After Dinner",    simplifiedInstructions: "After Dinner",    startDate: "2024-05-01", color: "#EC4899" },
    ],
    doseLogs: [
      { id: "d1", medicineId: "m1", medicineName: "Metformin 500mg",  scheduledTime: "9:00 AM",  status: "taken",   date: new Date().toISOString().split("T")[0] },
      { id: "d2", medicineId: "m2", medicineName: "Amlodipine 5mg",   scheduledTime: "2:00 PM",  status: "pending", date: new Date().toISOString().split("T")[0] },
      { id: "d3", medicineId: "m3", medicineName: "Atorvastatin 10mg",scheduledTime: "9:00 PM",  status: "pending", date: new Date().toISOString().split("T")[0] },
    ],
  },
  {
    id: "mock-2",
    name: "Sunita Sharma",
    age: 52,
    relation: "Mother",
    condition: "Thyroid, Vitamin D Deficiency",
    dischargeDate: "2024-04-15",
    emergencyContact: "9876543210",
    bloodGroup: "B+",
    weight: "62 kg",
    height: "5'4\"",
    doctor: "Dr. Priya Nair",
    lastVisit: "15 May 2024",
    nextVisit: "15 Jun 2024",
    riskScore: 22,
    riskLevel: "Low",
    healthLogs: { bp: "118/76", sugar: "95 mg/dL", weight: "62 kg", date: "18 May 2024" },
    medicines: [
      { id: "m4", name: "Thyroxine 50mcg", dosage: "50mcg", frequency: "daily", times: ["07:00"], instructions: "Before Breakfast", simplifiedInstructions: "Before Breakfast", startDate: "2024-04-15", color: "#10B981" },
      { id: "m5", name: "Vitamin D3 60K",  dosage: "60K",   frequency: "weekly",times: ["08:30"], instructions: "After Breakfast",  simplifiedInstructions: "After Breakfast",  startDate: "2024-04-15", color: "#F59E0B" },
    ],
    doseLogs: [
      { id: "d4", medicineId: "m4", medicineName: "Thyroxine 50mcg", scheduledTime: "7:00 AM",  status: "taken",   date: new Date().toISOString().split("T")[0] },
      { id: "d5", medicineId: "m5", medicineName: "Vitamin D3 60K",  scheduledTime: "8:30 AM",  status: "pending", date: new Date().toISOString().split("T")[0] },
    ],
  },
  {
    id: "mock-3",
    name: "Aarav Sharma",
    age: 16,
    relation: "Son",
    condition: "Seasonal Allergies",
    dischargeDate: "2024-05-10",
    emergencyContact: "9876543210",
    bloodGroup: "O+",
    weight: "55 kg",
    height: "5'7\"",
    doctor: "Dr. Suresh Rao",
    lastVisit: "10 May 2024",
    nextVisit: "10 Jun 2024",
    riskScore: 12,
    riskLevel: "Low",
    healthLogs: { bp: "110/70", sugar: "90 mg/dL", weight: "55 kg", date: "18 May 2024" },
    medicines: [
      { id: "m6", name: "Cetirizine 10mg", dosage: "10mg", frequency: "daily", times: ["22:00"], instructions: "Before Bed", simplifiedInstructions: "Before Bed", startDate: "2024-05-10", color: "#8B5CF6" },
    ],
    doseLogs: [
      { id: "d6", medicineId: "m6", medicineName: "Cetirizine 10mg", scheduledTime: "10:00 PM", status: "pending", date: new Date().toISOString().split("T")[0] },
    ],
  },
];

export type AuthMethod = "password" | "google" | null;

export interface AppUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
  avatar?: string;
  role: UserRole;
  isEmailVerified?: boolean;
  linkedPatientId?: string;
  bloodType?: string;
  allergies?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  xpReward: number;
  unlockedAt?: string;
}

export interface JournalEntry {
  id: string;
  date: string;
  mood: number;
  energy: number;
  text: string;
}

export interface DoseHistoryDay {
  date: string;
  taken: number;
  total: number;
  percentage: number;
}

export interface DrugInteraction {
  medIds: string[];
  severity: "mild" | "moderate" | "high";
  description: string;
}

export type BloodType = "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-";

export interface BloodDonor {
  id: string;
  name: string;
  bloodType: BloodType;
  phone: string;
  area?: string | null;
  city?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  isAvailable: boolean;
  lastDonation?: string | null;
  distanceKm?: number | null;
}

export interface BloodRequestItem {
  id: string;
  patientName: string;
  bloodType: BloodType;
  unitsNeeded: number;
  hospital: string;
  area?: string | null;
  city?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  urgency: "low" | "normal" | "critical";
  contactPhone: string;
  note?: string | null;
  status: "open" | "fulfilled" | "cancelled";
  createdAt?: string;
  distanceKm?: number | null;
}

export interface NearbyQuery {
  lat?: number;
  lng?: number;
  bloodType?: BloodType;
  radiusKm?: number;
}

export interface DonorProfileInput {
  name: string;
  bloodType: BloodType;
  phone: string;
  area?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  isAvailable?: boolean;
  lastDonation?: string;
}

export interface BloodRequestInput {
  patientName: string;
  bloodType: BloodType;
  unitsNeeded?: number;
  hospital: string;
  area?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  urgency?: "low" | "normal" | "critical";
  contactPhone: string;
  note?: string;
}

export interface DrugInteractionFinding {
  pair: [string, string] | string[];
  severity: "mild" | "moderate" | "high";
  description: string;
  advice: string;
}

export interface DrugCheckResult {
  interactions: DrugInteractionFinding[];
  foodWarnings: string[];
  summary: string;
  hasCritical: boolean;
  medicinesChecked?: string[];
}

export interface ExtractedMedicine {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  timing: string;
  notes: string;
  confidence: number;
  low_confidence: boolean;
  simplifiedInstructions?: string;
  times?: string[];
}

export interface PrescriptionAnalysisResult {
  medicines: ExtractedMedicine[];
  general_instructions: string;
  explanation: string;
  warnings: string[];
  overall_confidence: number;
  ocr_source: string;
  processing_note: string;
}

export type NotifItem = {
  id: string;
  icon: any;
  color: string;
  title: string;
  body: string;
  time: string;
  read: boolean;
};

export type NotifGroup = {
  group: string;
  items: NotifItem[];
};

const ALL_ACHIEVEMENTS: Achievement[] = [
  { id: "first_dose", title: "First Step", description: "Take your first medicine", icon: "💊", xpReward: 50 },
  { id: "streak_3", title: "On a Roll", description: "3-day adherence streak", icon: "🔥", xpReward: 75 },
  { id: "streak_7", title: "Week Warrior", description: "7-day streak — impressive!", icon: "⚡", xpReward: 150 },
  { id: "streak_30", title: "Month Master", description: "30-day streak — legendary!", icon: "🏆", xpReward: 500 },
  { id: "symptom_logger", title: "Health Tracker", description: "Log your first symptom", icon: "📊", xpReward: 40 },
  { id: "journal_keeper", title: "Journal Keeper", description: "Write your first journal entry", icon: "📝", xpReward: 40 },
  { id: "scan_master", title: "Scan Master", description: "Scan a prescription", icon: "📷", xpReward: 60 },
  { id: "full_day", title: "Perfect Day", description: "Take ALL doses in one day", icon: "⭐", xpReward: 100 },
  { id: "follow_up", title: "Appointment Pro", description: "Complete a follow-up", icon: "📅", xpReward: 80 },
  { id: "week_perfect", title: "Superstar", description: "Perfect adherence for 7 days", icon: "🌟", xpReward: 300 },
];

const DRUG_INTERACTIONS: DrugInteraction[] = [
  {
    medIds: ["m1", "m3"],
    severity: "mild",
    description: "Metformin + Aspirin may slightly increase hypoglycemia risk. Monitor blood sugar closely.",
  },
  {
    medIds: ["m2", "m4"],
    severity: "mild",
    description: "Lisinopril + Atorvastatin: monitor for muscle weakness or pain.",
  },
  {
    medIds: ["m3", "m4"],
    severity: "mild",
    description: "Aspirin + Atorvastatin: generally safe but watch for unusual bleeding.",
  },
];

const XP_LEVELS = [
  { level: 1, title: "Recovery Starter", min: 0, max: 150 },
  { level: 2, title: "Getting Stronger", min: 150, max: 400 },
  { level: 3, title: "Dedicated Patient", min: 400, max: 800 },
  { level: 4, title: "Health Champion", min: 800, max: 1500 },
  { level: 5, title: "Recovery Master", min: 1500, max: 9999 },
];

export function getLevel(xp: number) {
  return XP_LEVELS.find((l) => xp >= l.min && xp < l.max) ?? XP_LEVELS[XP_LEVELS.length - 1];
}

interface AppContextType {
  user: AppUser | null;
  role: UserRole;
  patient: Patient | null;
  medicines: Medicine[];
  todayDoses: DoseLog[];
  symptomLogs: SymptomLog[];
  followUps: FollowUp[];
  isOnboarded: boolean;
  language: Language;
  linkedPatients: Patient[];
  familyMembers: Patient[];
  activePatientId: string | null;
  isProcessingPrescription: boolean;
  hapticsEnabled: boolean;
  // Gamification
  streak: number;
  xp: number;
  achievements: Achievement[];
  doseHistory: DoseHistoryDay[];
  lastXPGain: number;
  // Journal
  journalEntries: JournalEntry[];
  // Notifications
  notifications: NotifGroup[];
  // Drug interactions
  drugInteractions: DrugInteraction[];
  recoverySuggestion: { title: string; body: string; type: 'calm' | 'sleep' | 'reset' } | null;
  token: string | null;
  // Actions
  setRole: (role: UserRole) => void;
  setUser: (user: AppUser) => void;
  addMedicine: (medicine: Omit<Medicine, "id">) => Promise<void>;
  updateMedicine: (id: string, medicine: Partial<Medicine>) => Promise<void>;
  deleteMedicine: (id: string) => Promise<void>;
  updateDoseStatus: (doseId: string, status: DoseLog["status"], snoozeMinutes?: number) => void;
  addSymptomLog: (log: SymptomLog) => void;
  addFollowUp: (followUp: FollowUp) => void;
  getRecoveryTrends: () => Promise<any>;
  simplifyInstruction: (text: string) => Promise<string>;
  completeFollowUp: (id: string) => void;
  setOnboarded: (val: boolean) => void;
  setHapticsEnabled: (val: boolean) => void;
  triggerEmergency: () => void;
  setLanguage: (lang: Language) => void;
  addPrescription: (imageBase64: string) => Promise<PrescriptionAnalysisResult>;
  addJournalEntry: (entry: JournalEntry) => void;
  awardXP: (amount: number) => void;
  unlockAchievement: (id: string) => void;
  updateProfile: (updates: Partial<AppUser>) => Promise<void>;
  changePassword: (old: string, newP: string) => Promise<void>;
  clearAllNotifications: () => void;
  markNotificationRead: (id: string) => void;
  login: (user: AppUser, token: string, authMethod?: AuthMethod) => Promise<void>;
  logout: () => void;
  authMethod: AuthMethod;
  resetOnboarding: () => void;
  switchProvider: (provider: IDataProvider) => void;
  clearRecoverySuggestion: () => void;
  refreshData: () => Promise<void>;
  addFamilyMember: (data: any) => Promise<void>;
  linkFamilyMember: (email: string) => Promise<void>;
  linkPatientByCode: (code: string) => Promise<void>;
  setActivePatientId: (id: string | null) => void;
  api: IDataProvider;
  showToast: (title: string, body: string) => void;
  addNotification: (item: Omit<NotifItem, "id" | "read" | "time">) => void;
  fetchBriefing: (patientId: string) => Promise<string>;
  isSpeaking: boolean;
  speakingTargetId: string | null;
  speakNeural: (text: string, targetId?: string) => Promise<void>;
  stopSpeaking: () => Promise<void>;
  isInitializing: boolean;
  isOnline: boolean;
}

const AppContext = createContext<AppContextType | null>(null);

const STORAGE_KEY = "discharge_buddy_data_v2";

// Dummy items moved to DataProvider implementations

export function AppProvider({ children }: { children: React.ReactNode }) {
  const isOnline = useConnectivity();
  const [user, setUserState] = useState<AppUser | null>(null);
  const [authMethod, setAuthMethodState] = useState<AuthMethod>(null);
  const [role, setRoleState] = useState<UserRole>(null);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [todayDoses, setTodayDoses] = useState<DoseLog[]>([]);
  const [symptomLogs, setSymptomLogs] = useState<SymptomLog[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [isOnboarded, setIsOnboardedState] = useState(false);
  const [language, setLanguageState] = useState<Language>("en");
  const [hapticsEnabled, setHapticsEnabledState] = useState(true);
  const [isProcessingPrescription, setIsProcessingPrescription] = useState(false);
  const [streak, setStreak] = useState(0);
  const [xp, setXP] = useState(340);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [doseHistory, setDoseHistory] = useState<DoseHistoryDay[]>([]);
  const [lastXPGain, setLastXPGain] = useState(0);
  const [linkedPatients, setLinkedPatients] = useState<Patient[]>([]);
  const [familyMembers, setFamilyMembers] = useState<Patient[]>([]);
  const [activePatientId, setActivePatientIdState] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotifGroup[]>([]);
  const [toast, setToast] = useState<{ visible: boolean; title: string; body: string }>({
    visible: false,
    title: "",
    body: "",
  });
  const [token, setToken] = useState<string | null>(null);

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakingTargetId, setSpeakingTargetId] = useState<string | null>(null);
  const audioRef = useRef<Audio.Sound | null>(null);

  const [dataProvider, setDataProvider] = useState<IDataProvider>(new ApiProvider());
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    // Shared initialization of base URL and token getter
    const apiUrl = getApiUrl();
    setBaseUrl(apiUrl);
    console.log("[AppContext] Base URL set to:", apiUrl);
    setAuthTokenGetter(async () => await AsyncStorage.getItem("discharge_buddy_token"));
    initApp();
  }, []);

  useEffect(() => {
    const checkTokenAndLoad = async () => {
      const token = await AsyncStorage.getItem("discharge_buddy_token");
      if (!isInitializing && (token || dataProvider instanceof MockProvider)) {
        loadData();
      }
    };
    checkTokenAndLoad();
  }, [dataProvider, isInitializing]);

  async function initApp() {
    try {
      const token = await AsyncStorage.getItem("discharge_buddy_token");
      if (token) setToken(token);
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      
      if (dataProvider instanceof MockProvider) {
          setDataProvider(new ApiProvider());
      }

      // Request notification permission on native (local notifications work in Expo Go, remote push does not)
      if (Platform.OS !== "web") {
        await requestNotificationPermissions();
      }

      if (raw) {
        const data = JSON.parse(raw);
        if (data.role) setRoleState(data.role);
        if (data.user) setUserState(data.user);
        if (data.authMethod) setAuthMethodState(data.authMethod);
        if (data.isOnboarded !== undefined) setIsOnboardedState(data.isOnboarded);
        if (data.hapticsEnabled !== undefined) setHapticsEnabledState(data.hapticsEnabled);
        if (data.language) setLanguageState(data.language);
        if (data.streak) setStreak(data.streak);
        if (data.xp) setXP(data.xp);
        if (data.achievements) setAchievements(data.achievements);
        if (data.notifications) setNotifications(data.notifications);
        // No dummy seed data — notifications populate from real app events.
      }
      
      // Register push token if logged in
      if (token) {
        const pushToken = await getDevicePushToken();
        if (pushToken && dataProvider.registerPushToken) {
          await dataProvider.registerPushToken(pushToken).catch(console.error);
        }
      }
    } catch (err) {
      console.error("Failed to initialize app state", err);
    } finally {
      setIsInitializing(false);
    }
  }

  async function loadData() {
    try {
      const dbMedicines = await dataProvider.getMedicines();
      setMedicines(dbMedicines);

      const dbTodayDoses = await dataProvider.getTodayDoses();
      setTodayDoses(dbTodayDoses);

      const dbSymptoms = await dataProvider.getSymptomLogs();
      setSymptomLogs(dbSymptoms);

      const dbFollowUps = await dataProvider.getFollowUps();
      setFollowUps(dbFollowUps);

      const dbJournal = await dataProvider.getJournalEntries();
      setJournalEntries(dbJournal);

      const dbPatients = await dataProvider.getLinkedPatients();
      setLinkedPatients(dbPatients);

      // For family role, also fetch family members
      if (role === 'family') {
        try {
          const dbFamilyMembers = await dataProvider.getFamilyMembers();
          // Only fall back to mock data in demo (MockProvider) mode, NOT for real users
          if (dbFamilyMembers.length > 0) {
            setFamilyMembers(dbFamilyMembers);
          } else if (dataProvider instanceof MockProvider) {
            setFamilyMembers(MOCK_FAMILY_MEMBERS);
          } else {
            // Real user with no family members yet — show empty state
            setFamilyMembers([]);
          }
        } catch (e) {
          // API unavailable — only use mock data in demo mode
          console.warn("Family API unavailable:", (e as any)?.message ?? e);
          if (dataProvider instanceof MockProvider) {
            setFamilyMembers(MOCK_FAMILY_MEMBERS);
          } else {
            setFamilyMembers([]);
          }
        }
      }

      const dbTrends = await dataProvider.getRecoveryTrends();
      
      const dbAdherenceHistory = await dataProvider.getAdherenceHistory();
      const historyFormatted = dbAdherenceHistory.map(h => ({
        date: h.date,
        taken: h.taken || 0,
        total: h.total || 0,
        percentage: h.percentage || 0
      }));
      setDoseHistory(historyFormatted);

      // Calculate dynamic streak based on adherence history
      let currentStreak = 0;
      const sortedHistory = [...historyFormatted].sort((a, b) => b.date.localeCompare(a.date));
      const todayStr = new Date().toISOString().split("T")[0];
      
      let streakIndex = 0;
      if (sortedHistory[0]?.date === todayStr) {
        if (sortedHistory[0].taken > 0) {
          currentStreak++;
        }
        streakIndex = 1; // move to yesterday
      }

      for (; streakIndex < sortedHistory.length; streakIndex++) {
        const day = sortedHistory[streakIndex];
        if (day.taken > 0) {
          currentStreak++;
        } else if (day.total > 0 && day.taken === 0) {
          break; // Streak broken
        }
      }
      setStreak(currentStreak);
      // Handle setting trends state if added to context
    } catch (err: any) {
      // Graceful handling of network failures to prevent "Red Screen of Death"
      if (err instanceof TypeError && err.message.includes("Network request failed")) {
        console.warn("Backend server unreachable. Using local cache if available.");
      } else if (
        err?.status === 403 &&
        (err?.data?.error === "EMAIL_NOT_VERIFIED" || err?.message?.includes("EMAIL_NOT_VERIFIED"))
      ) {
        // Partial session: token is valid but the account's email is no longer
        // verified (e.g. registered then closed the app before confirming).
        // Proactively send the user back to the verification screen.
        console.warn("Session is partial — email not verified. Prompting re-verification.");
        const email = await getPersistedEmail();
        if (email) {
          router.replace(`/verify-email?email=${encodeURIComponent(email)}` as any);
        } else {
          router.replace("/login");
        }
      } else if (err?.status === 401 || err?.message?.includes("401")) {
        console.warn("Session expired. Logging out automatically.");
        logout();
      } else {
        console.error("Failed to load generic data", err);
      }
    }
  }

  // Reads the persisted user's email straight from storage so it is reliable
  // even before the `user` state has hydrated (avoids stale-closure nulls).
  async function getPersistedEmail(): Promise<string | null> {
    try {
      if (user?.email) return user.email;
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw)?.user?.email ?? null;
    } catch {
      return null;
    }
  }

  async function saveData(updates: Record<string, unknown>) {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const existing = raw ? JSON.parse(raw) : {};
      const merged = { ...existing, ...updates };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch (err) {
      console.warn("[AppContext] Failed to save data:", err);
    }
  }

  const [recoverySuggestion, setRecoverySuggestion] = useState<{ title: string; body: string; type: 'calm' | 'sleep' | 'reset' } | null>(null);

  // Recovery Suggestion Logic
  useEffect(() => {
    if (role !== 'patient') return;
    
    const checkSuggestions = () => {
      // Rule 1: Missed Dose
      const missedCount = todayDoses.filter(d => d.status === 'missed').length;
      if (missedCount >= 1) {
        setRecoverySuggestion({
          title: "Feeling overwhelmed?",
          body: "Take a 2-min reset to calm your mind.",
          type: 'calm'
        });
        return;
      }

      // Rule 2: Night Time (Sleep Prep)
      const hour = new Date().getHours();
      if (hour >= 21) {
        setRecoverySuggestion({
          title: "Prepare for sleep",
          body: "Wind down for better recovery tonight.",
          type: 'sleep'
        });
        return;
      }
      
      setRecoverySuggestion(null);
    };

    checkSuggestions();
  }, [todayDoses, role]);

  const clearRecoverySuggestion = () => setRecoverySuggestion(null);

  const awardXP = useCallback((amount: number) => {
    setLastXPGain(amount);
    setXP((prev) => {
      const next = prev + amount;
      saveData({ xp: next });
      return next;
    });
    setTimeout(() => setLastXPGain(0), 2000);
  }, []);

  const unlockAchievement = useCallback((id: string) => {
    setAchievements((prev) => {
      if (prev.find((a) => a.id === id)?.unlockedAt) return prev;
      const template = ALL_ACHIEVEMENTS.find((a) => a.id === id);
      if (!template) return prev;
      const updated = prev.map((a) =>
        a.id === id ? { ...a, unlockedAt: new Date().toISOString() } : a
      );
      if (!prev.find((a) => a.id === id)) {
        updated.push({ ...template, unlockedAt: new Date().toISOString() });
      }
      saveData({ achievements: updated });
      return updated;
    });
    const template = ALL_ACHIEVEMENTS.find((a) => a.id === id);
    if (template) awardXP(template.xpReward);
  }, [awardXP]);

  const setRole = (r: UserRole) => { setRoleState(r); saveData({ role: r }); };
  const setUser = (u: AppUser) => { setUserState(u); saveData({ user: u }); };
  const setHapticsEnabled = (val: boolean) => { setHapticsEnabledState(val); saveData({ hapticsEnabled: val }); };
  const setLanguage = (lang: Language) => { setLanguageState(lang); saveData({ language: lang }); };

  const addMedicine = async (medData: Omit<Medicine, "id">) => {
    const newMed = await dataProvider.addMedicine(medData);
    // Schedule local notifications for each dose time as a device-side fallback
    if (newMed && Platform.OS !== "web") {
      await scheduleMedicineNotifications(newMed).catch(console.warn);
    }
    await loadData();
    unlockAchievement("first_step");
  };

  const updateMedicine = async (id: string, updates: Partial<Medicine>) => {
    await dataProvider.updateMedicine?.(id, updates);
    // Reschedule notifications with new times
    if (updates.times && Platform.OS !== "web") {
      const updatedMed = medicines.find(m => m.id === id);
      if (updatedMed) {
        await scheduleMedicineNotifications({ ...updatedMed, ...updates } as Medicine).catch(console.warn);
      }
    }
    await loadData();
  };

  const deleteMedicine = async (id: string) => {
    await dataProvider.deleteMedicine?.(id);
    await loadData();
  };

  const updateDoseStatus = async (doseId: string, status: DoseLog["status"], snoozeMinutes?: number) => {
    await dataProvider.updateDoseStatus(doseId, status, snoozeMinutes);
    
    // Execute side effects outside of the setState callback
    if (status === "taken") {
      soundHelper.playTing();
      awardXP(10);
      unlockAchievement("first_dose");
      
      const todayStr = new Date().toISOString().split("T")[0];
      const allTaken = todayDoses.map(d => d.id === doseId ? { ...d, status } : d)
        .filter(d => d.date === todayStr)
        .every(d => d.status === "taken");
        
      if (allTaken) {
        awardXP(40);
        unlockAchievement("full_day");
      }

      setDoseHistory(prevHistory => {
        const newHistory = prevHistory.map(h => {
          if (h.date === todayStr) {
            const newTaken = h.taken + 1;
            return { ...h, taken: newTaken, percentage: h.total > 0 ? Math.round((newTaken / h.total) * 100) : 0 };
          }
          return h;
        });

        let currentStreak = 0;
        const sortedHistory = [...newHistory].sort((a, b) => b.date.localeCompare(a.date));
        let streakIndex = 0;
        if (sortedHistory[0]?.date === todayStr) {
          if (sortedHistory[0].taken > 0) currentStreak++;
          streakIndex = 1;
        }
        for (; streakIndex < sortedHistory.length; streakIndex++) {
          const day = sortedHistory[streakIndex];
          if (day.taken > 0) currentStreak++;
          else if (day.total > 0 && day.taken === 0) break;
        }
        setStreak(currentStreak);
        return newHistory;
      });

      const med = medicines.find(m => m.id === doseId) || todayDoses.find(d => d.id === doseId);
      const name = med ? ('name' in med ? med.name : (med as any).medicineName) : "Medicine";
      
      addNotification({
        title: "Dose Taken",
        body: `${name} — marked as taken`,
        icon: "check-circle",
        color: "#10b981"
      });
    }

    setTodayDoses((prev) => 
      prev.map((d) => d.id === doseId ? { ...d, status, takenAt: status === "taken" ? new Date().toISOString() : undefined } : d)
    );
  };

  const addSymptomLog = async (log: SymptomLog) => {
    await dataProvider.addSymptomLog(log);
    
    setSymptomLogs([log, ...symptomLogs]);
    awardXP(15);
    unlockAchievement("symptom_logger");
    addNotification({
      title: "Symptom Logged",
      body: `${log.symptoms.length} symptoms recorded`,
      icon: "activity",
      color: "#ef4444"
    });
  };

  const addFollowUp = async (followUp: FollowUp) => {
    await dataProvider.addFollowUp(followUp);
    setFollowUps([followUp, ...followUps]);
  };

  const completeFollowUp = async (id: string) => {
    await dataProvider.completeFollowUp(id);
    
    setFollowUps(followUps.map((f) => (f.id === id ? { ...f, completed: true } : f)));
    awardXP(25);
    unlockAchievement("follow_up");
  };

  const addJournalEntry = async (journalEntry: JournalEntry) => {
    await dataProvider.addJournalEntry(journalEntry);
    
    setJournalEntries([journalEntry, ...journalEntries]);
    awardXP(20);
    unlockAchievement("journal_keeper");
    addNotification({
      title: "Journal Entry Added",
      body: "Your daily reflections have been saved",
      icon: "book-open",
      color: "#8b5cf6"
    });
  };

  const triggerEmergency = async () => {
    await dataProvider.triggerEmergency();
    console.log("EMERGENCY ACTUALLY TRIGGERED AND SENT TO BACKEND");
  };

  const addPrescription = async (imageBase64: string): Promise<PrescriptionAnalysisResult> => {
    setIsProcessingPrescription(true);
    try {
      const result = await dataProvider.scanPrescription(imageBase64);
      unlockAchievement("scan_master");
      return result;
    } finally {
      setIsProcessingPrescription(false);
    }
  };

  const getRecoveryTrends = async () => {
    return await dataProvider.getRecoveryTrends();
  };

  const simplifyInstruction = async (text: string) => {
    return await dataProvider.simplifyInstruction(text);
  };



  const stopSpeaking = useCallback(async () => {
    try {
      // Stop device TTS
      Speech.stop();
      
      // Stop remote audio
      if (audioRef.current) {
        await audioRef.current.stopAsync();
        await audioRef.current.unloadAsync();
        audioRef.current = null;
      }
    } catch (e) {
      console.warn("Could not stop speech:", e);
    }
    setIsSpeaking(false);
    setSpeakingTargetId(null);
  }, []);

  const speakNeural = async (text: string, targetId?: string) => {
    if (!text) return;

    // If already speaking the same thing, stop it
    if (isSpeaking && speakingTargetId === targetId) {
      stopSpeaking();
      return;
    }

    // Stop any current speech before starting new
    await stopSpeaking();

    if (hapticsEnabled && Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setIsSpeaking(true);
    if (targetId) setSpeakingTargetId(targetId);
    
    // Strip ALL emojis and special symbols so they aren't read aloud
    const cleanText = text
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA9F}\u{1FAA0}-\u{1FAFF}\u{200D}\u{20E3}\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Use device-native speech engine for instant, zero-latency playback
    try {
      Speech.speak(cleanText, {
        language: LOCALE_BY_LANG[language] || 'en-US',
        pitch: 1.0,
        rate: 0.95,
        onDone: () => {
          setIsSpeaking(false);
          setSpeakingTargetId(null);
        },
        onError: () => {
          setIsSpeaking(false);
          setSpeakingTargetId(null);
        }
      });
    } catch (speechErr) {
      console.error("[Local Speech Error]", speechErr);
      setIsSpeaking(false);
      setSpeakingTargetId(null);
    }
  };

  const fetchBriefing = async (patientId: string) => {
    try {
      const token = await AsyncStorage.getItem("discharge_buddy_token");
      const apiUrl = process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/api/caregiver/briefing/${patientId}`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (!res.ok) throw new Error("Failed to fetch briefing");
      const data = await res.json();
      return data.summary;
    } catch (err) {
      console.error("Briefing Fetch Error:", err);
      return "Unable to load patient briefing at this time.";
    }
  };

  const checkInteractions = (meds: Medicine[]): DrugInteraction[] => {
    const ids = meds.map((m) => m.id);
    return DRUG_INTERACTIONS.filter((i) => i.medIds.every((id) => ids.includes(id)));
  };

  const login = async (userData: AppUser, token: string, method: AuthMethod = "password") => {
    await AsyncStorage.setItem("discharge_buddy_token", token);
    setToken(token);

    // Batch updates to state and storage to prevent race conditions
    setUserState(userData);
    setAuthMethodState(method);
    setRoleState(userData.role);
    setIsOnboardedState(true);
    setDataProvider(new ApiProvider());

    await saveData({
      user: userData,
      authMethod: method,
      role: userData.role,
      isOnboarded: true
    });

    // Register Push Token with Backend

    // Register Push Token with Backend
    try {
      const pushToken = await getDevicePushToken();
      if (pushToken) {
        const apiUrl = process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000";
        await fetch(`${apiUrl}/api/auth/push-token`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({ token: pushToken })
        });
        console.log("Push token registered successfully with backend");
      }
    } catch (err) {
      console.warn("Failed to register push token during login:", err);
    }
  };

  const logout = () => {
    stopSpeaking();
    // Wipe conversation memory for this user (privacy — voice transcripts).
    clearConversationHistory(user?.email || "guest").catch(() => {});
    AsyncStorage.removeItem("discharge_buddy_token");
    setToken(null);
    AsyncStorage.removeItem(STORAGE_KEY);
    setUserState(null);
    setAuthMethodState(null);
    setRoleState(null);
    setIsOnboardedState(false);
    setDataProvider(new MockProvider());
    router.replace("/");
  };

  const updateProfile = async (updates: Partial<AppUser>) => {
    const updatedUser = await dataProvider.updateProfile(updates);
    setUserState(updatedUser);
    saveData({ user: updatedUser });
  };

  const changePassword = async (old: string, newP: string) => {
    await dataProvider.changePassword(old, newP);
  };

  const clearAllNotifications = () => {
    setNotifications([]);
    saveData({ notifications: [] });
  };

  const markNotificationRead = (id: string) => {
    setNotifications(prev => {
      const updated = prev.map(g => ({
        ...g,
        items: g.items.map(i => i.id === id ? { ...i, read: true } : i)
      }));
      saveData({ notifications: updated });
      return updated;
    });
  };

  const showToast = useCallback((title: string, body: string) => {
    setToast({ visible: true, title, body });
  }, []);

  const hideToast = useCallback(() => {
    setToast(prev => ({ ...prev, visible: false }));
  }, []);

  const addNotification = useCallback((item: Omit<NotifItem, "id" | "read" | "time">) => {
    const newItem: NotifItem = {
      ...item,
      id: Date.now().toString(),
      read: false,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setNotifications(prev => {
      let updated = [...prev];
      if (updated.length === 0 || updated[0].group !== "Today") {
        updated.unshift({ group: "Today", items: [newItem] });
      } else {
        updated[0] = { ...updated[0], items: [newItem, ...updated[0].items] };
      }
      saveData({ notifications: updated });
      return updated;
    });

    // Also trigger a visual toast for immediate feedback
    showToast(item.title, item.body);
  }, [showToast]);

  const resetOnboarding = () => {
    setIsOnboardedState(false);
    saveData({ isOnboarded: false });
  };

  const setOnboarded = (val: boolean) => {
    setIsOnboardedState(val);
    saveData({ isOnboarded: val });
  };

  const switchProvider = (provider: IDataProvider) => {
    setDataProvider(provider);
  };

  const addFamilyMember = async (data: any) => {
    try {
      const newMember = await dataProvider.addFamilyMember(data);
      setFamilyMembers(prev => [...prev, newMember]);
      showToast("Member Added", `${newMember.name} has been added to your family.`);
    } catch (e: any) {
      console.warn("API addFamilyMember failed:", e);
      // Fallback to mock update so the UI still works
      const mockMember: Patient = {
        id: `mock-added-${Date.now()}`,
        name: data.name,
        age: data.age ? parseInt(data.age) : 0,
        condition: data.condition || "Healthy",
        relation: data.relation || undefined,
        avatar: data.avatar || undefined,
        dischargeDate: new Date().toISOString(),
        emergencyContact: "N/A",
        medicines: [],
        doseLogs: [],
      };
      setFamilyMembers(prev => [...prev, mockMember]);
      showToast("Member Added (Offline Mode)", `${mockMember.name} was added locally.`);
    }
  };

  const linkFamilyMember = async (email: string) => {
    try {
      const linkedMember = await dataProvider.linkFamilyMember(email);
      setFamilyMembers(prev => [...prev, linkedMember]);
      showToast("Account Linked", `${linkedMember.name}'s account has been linked.`);
    } catch (e: any) {
      console.warn("API linkFamilyMember failed:", e);
      throw e; // Rethrow to let the UI show the 'Not Found' alert
    }
  };

  const linkPatientByCode = async (code: string) => {
    try {
      const linkedMember = await dataProvider.linkPatientByCode(code);
      setFamilyMembers(prev => {
        if (prev.some(m => m.id === linkedMember.id)) return prev; // avoid duplicates
        return [...prev, linkedMember];
      });
      showToast("Patient Linked", `${linkedMember.name} has been linked to your account.`);
    } catch (e: any) {
      console.warn("API linkPatientByCode failed:", e);
      throw e; // Rethrow so the UI can show a friendly message
    }
  };

  const setActivePatientId = (id: string | null) => {
    setActivePatientIdState(id);
  };

  return (
    <AppContext.Provider
      value={{
        user, authMethod, role, patient: null, medicines, todayDoses, symptomLogs, followUps,
        isOnboarded, language, linkedPatients, familyMembers, activePatientId, isProcessingPrescription,
        hapticsEnabled,
        streak, xp, achievements, doseHistory, lastXPGain, journalEntries,
        drugInteractions: checkInteractions(medicines),
        recoverySuggestion,
        token,
        setRole, setUser, addMedicine, updateMedicine, deleteMedicine, updateDoseStatus, addSymptomLog, addFollowUp,
        completeFollowUp, setOnboarded, setHapticsEnabled, triggerEmergency, setLanguage, addPrescription,
        addJournalEntry, awardXP, unlockAchievement, login, logout, resetOnboarding, switchProvider,
        getRecoveryTrends, simplifyInstruction, updateProfile, changePassword,
        notifications, clearAllNotifications, markNotificationRead, addNotification,
        clearRecoverySuggestion,
        refreshData: loadData,
        addFamilyMember, linkFamilyMember, linkPatientByCode, setActivePatientId,
        api: dataProvider,
        showToast,
        fetchBriefing,
        isSpeaking,
        speakingTargetId,
        speakNeural,
        stopSpeaking,
        isInitializing,
        isOnline,
      }}
    >
      {children}
      <NotificationToast 
        visible={toast.visible}
        title={toast.title}
        body={toast.body}
        onHide={hideToast}
      />
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    console.error("useApp was called outside AppProvider!");
    // Return a proxy that prevents immediate destructuring crashes
    return new Proxy({}, {
      get: (target, prop) => {
        if (prop === 'language') return 'en';
        if (prop === 'isOnboarded') return false;
        return undefined;
      }
    }) as AppContextType;
  }
  return ctx;
}

export { ALL_ACHIEVEMENTS, DRUG_INTERACTIONS, XP_LEVELS };
