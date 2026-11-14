import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  getDocs,
} from "firebase/firestore";
import firebaseConfig from "../../firebase-applet-config.json";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Configure Google OAuth Provider with exact Workspace scopes
export const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
];

const googleProvider = new GoogleAuthProvider();
WORKSPACE_SCOPES.forEach((scope) => googleProvider.addScope(scope));
googleProvider.setCustomParameters({ prompt: "consent" });

// In-memory access token cache (NEVER stored in localStorage/sessionStorage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;

// Validate connection to Firestore on boot (Mandatory per firebase-integration-rpc)
async function testConnection() {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export const initAuth = (
  onAuthReady: (user: User | null, token: string | null) => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      await ensureUserProfile(user);
      onAuthReady(user, cachedAccessToken);
    } else {
      cachedAccessToken = null;
      onAuthReady(null, null);
    }
  });
};

export const googleSignIn = async (): Promise<{
  user: User;
  accessToken: string | null;
}> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    cachedAccessToken = credential?.accessToken || null;
    await ensureUserProfile(result.user);
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error) {
    console.error("Google Sign-In error:", error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};

// Sanitize ID to match ^[a-zA-Z0-9_\-]+$ and maxLength 128
export function makeSafeId(prefix: string): string {
  const rand = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
}

export async function ensureUserProfile(user: User) {
  if (!user.emailVerified) return;
  const userPath = `users/${user.uid}`;
  const userRef = doc(db, "users", user.uid);
  try {
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      const displayName = (user.displayName || user.email?.split("@")[0] || "User")
        .trim()
        .slice(0, 120);
      await setDoc(userRef, {
        uid: user.uid,
        displayName: displayName.length > 0 ? displayName : "User",
        language: "ar",
        preferredModel: "gemini-3.8-flash",
        memoryRetentionDays: 30,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

export async function updateUserPreferences(
  uid: string,
  updates: {
    displayName: string;
    language: "ar" | "en";
    preferredModel: "gemini-4-argon" | "gemini-3.8-flash" | "gemini-3.1-flash-lite";
    memoryRetentionDays: number;
  }
) {
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, "users", uid), {
      displayName: updates.displayName.trim().slice(0, 120) || "User",
      language: updates.language === "en" ? "en" : "ar",
      preferredModel: updates.preferredModel,
      memoryRetentionDays: Math.min(365, Math.max(1, Math.round(updates.memoryRetentionDays))),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function saveMessageTurn(params: {
  userId: string;
  role: "user" | "model";
  content: string;
  skillUsed: string;
  modelUsed: string;
  tokensUsed: number;
}) {
  if (!auth.currentUser?.emailVerified) return;
  const msgId = makeSafeId("msg");
  const path = `messages/${msgId}`;
  try {
    await setDoc(doc(db, "messages", msgId), {
      userId: params.userId,
      role: params.role,
      content: (params.content || "").trim().slice(0, 20000) || "-",
      skillUsed: (params.skillUsed || "ChatSkill").slice(0, 64),
      modelUsed: (params.modelUsed || "gemini-3.8-flash").slice(0, 64),
      tokensUsed: Math.max(0, Math.min(1000000, Math.round(params.tokensUsed || 0))),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function saveProcessedFileRecord(params: {
  userId: string;
  fileName: string;
  fileType: string;
  direction: "analyzed" | "generated";
  summary: string;
}) {
  if (!auth.currentUser?.emailVerified) return;
  const fileId = makeSafeId("file");
  const path = `files/${fileId}`;
  try {
    await setDoc(doc(db, "files", fileId), {
      userId: params.userId,
      fileName: (params.fileName || "Document").trim().slice(0, 255),
      fileType: (params.fileType || "application/octet-stream").trim().slice(0, 120),
      direction: params.direction,
      summary: (params.summary || "Processed by Mr. Hany").trim().slice(0, 8000),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function createMemoryItem(params: {
  userId: string;
  category: "preference" | "project" | "engineering" | "note";
  title: string;
  content: string;
}) {
  if (!auth.currentUser?.emailVerified) return;
  const memId = makeSafeId("mem");
  const path = `memories/${memId}`;
  try {
    await setDoc(doc(db, "memories", memId), {
      userId: params.userId,
      category: params.category,
      title: params.title.trim().slice(0, 200) || "Note",
      content: params.content.trim().slice(0, 5000) || "-",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteMemoryItem(memoryId: string) {
  const path = `memories/${memoryId}`;
  try {
    await deleteDoc(doc(db, "memories", memoryId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function clearUserMessageHistory(userId: string) {
  const path = "messages";
  try {
    const q = query(collection(db, "messages"), where("userId", "==", userId));
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      await deleteDoc(doc(db, "messages", d.id));
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export { collection, query, where, onSnapshot, doc, getDocs };
