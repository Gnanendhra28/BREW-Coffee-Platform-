"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
} from "firebase/auth";
import { auth, googleProvider, isFirebaseConfigured } from "@/lib/firebase";
import type { UserRole } from "@/lib/authTokens";

export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: UserRole;
  isDemo?: boolean;
}

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  isConfigured: boolean;
  authModalOpen: boolean;
  setAuthModalOpen: (open: boolean) => void;
  authModalTab: "login" | "signup" | "reset";
  setAuthModalTab: (tab: "login" | "signup" | "reset") => void;
  openAuthModal: (tab?: "login" | "signup" | "reset") => void;
  closeAuthModal: () => void;
  signInWithEmail: (email: string, pass: string, desiredRole?: UserRole) => Promise<void>;
  signUpWithEmail: (email: string, pass: string, name?: string) => Promise<void>;
  signInWithGoogle: (desiredRole?: UserRole) => Promise<void>;
  loginWithStaffPin: (pin: string) => Promise<{ success: boolean; role?: UserRole; error?: string }>;
  resetPassword: (email: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  demoSignIn: (name?: string, email?: string, role?: UserRole) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Syncs session cookie with Edge Middleware
async function syncSessionCookie(userData: AppUser) {
  try {
    await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: userData,
        role: userData.role,
      }),
    });
  } catch (e) {
    console.warn("Failed to sync session cookie:", e);
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<"login" | "signup" | "reset">("login");

  // Load demo user or session cookie / Firebase listener
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const restoreSession = async () => {
      // 1. Check server session cookie first
      try {
        const res = await fetch("/api/auth/session");
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated && data.user) {
            setUser({
              ...data.user,
              photoURL: null,
              isDemo: false,
            });
            setLoading(false);
            return;
          }
        }
      } catch {
        // Fallback to local storage
      }

      // 2. Check localStorage fallback
      if (typeof window !== "undefined") {
        const storedDemo = localStorage.getItem("brew_demo_user");
        if (storedDemo) {
          try {
            const parsed = JSON.parse(storedDemo);
            setUser(parsed);
            syncSessionCookie(parsed);
            setLoading(false);
            return;
          } catch {
            localStorage.removeItem("brew_demo_user");
          }
        }
      }

      // 3. Listen for Firebase Auth state changes
      try {
        unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
          if (firebaseUser) {
            const appUser: AppUser = {
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName,
              photoURL: firebaseUser.photoURL,
              role: "customer",
              isDemo: false,
            };
            setUser(appUser);
            await syncSessionCookie(appUser);
          } else {
            setUser((currentUser) => (currentUser?.isDemo ? currentUser : null));
          }
          setLoading(false);
        });
      } catch (err) {
        console.warn("Firebase Auth listener initialized with fallback", err);
        setLoading(false);
      }
    };

    restoreSession();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const openAuthModal = (tab: "login" | "signup" | "reset" = "login") => {
    setAuthModalTab(tab);
    setAuthModalOpen(true);
  };

  const closeAuthModal = () => {
    setAuthModalOpen(false);
  };

  const signInWithEmail = async (email: string, pass: string, desiredRole: UserRole = "customer") => {
    if (!isFirebaseConfigured) {
      throw new Error("FIREBASE_NOT_CONFIGURED");
    }
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    if (typeof window !== "undefined") {
      localStorage.removeItem("brew_demo_user");
    }
    const appUser: AppUser = {
      uid: cred.user.uid,
      email: cred.user.email,
      displayName: cred.user.displayName,
      photoURL: cred.user.photoURL,
      role: desiredRole,
      isDemo: false,
    };
    setUser(appUser);
    await syncSessionCookie(appUser);
    setAuthModalOpen(false);
  };

  const signUpWithEmail = async (email: string, pass: string, name?: string) => {
    if (!isFirebaseConfigured) {
      throw new Error("FIREBASE_NOT_CONFIGURED");
    }
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    if (name && cred.user) {
      await updateProfile(cred.user, { displayName: name });
    }
    if (typeof window !== "undefined") {
      localStorage.removeItem("brew_demo_user");
    }
    const appUser: AppUser = {
      uid: cred.user.uid,
      email: cred.user.email,
      displayName: name || cred.user.displayName,
      photoURL: cred.user.photoURL,
      role: "customer",
      isDemo: false,
    };
    setUser(appUser);
    await syncSessionCookie(appUser);
    setAuthModalOpen(false);
  };

  const signInWithGoogle = async (desiredRole: UserRole = "customer") => {
    if (!isFirebaseConfigured) {
      throw new Error("FIREBASE_NOT_CONFIGURED");
    }
    const cred = await signInWithPopup(auth, googleProvider);
    if (typeof window !== "undefined") {
      localStorage.removeItem("brew_demo_user");
    }
    const appUser: AppUser = {
      uid: cred.user.uid,
      email: cred.user.email,
      displayName: cred.user.displayName,
      photoURL: cred.user.photoURL,
      role: desiredRole,
      isDemo: false,
    };
    setUser(appUser);
    await syncSessionCookie(appUser);
    setAuthModalOpen(false);
  };

  const loginWithStaffPin = async (pin: string): Promise<{ success: boolean; role?: UserRole; error?: string }> => {
    try {
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "staff_pin", pin }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || "Invalid Security PIN" };
      }

      const staffUser: AppUser = {
        uid: data.user.uid,
        displayName: data.user.displayName,
        email: data.user.email,
        photoURL: null,
        role: data.user.role,
        isDemo: false,
      };

      setUser(staffUser);
      if (typeof window !== "undefined") {
        localStorage.setItem("brew_demo_user", JSON.stringify(staffUser));
      }
      return { success: true, role: data.user.role };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Network error";
      return { success: false, error: message };
    }
  };

  const resetPassword = async (email: string) => {
    if (!isFirebaseConfigured) {
      throw new Error("FIREBASE_NOT_CONFIGURED");
    }
    await sendPasswordResetEmail(auth, email);
  };

  const demoSignIn = async (
    name = "Coffee Connoisseur",
    email = "coffee.lover@brew.cafe",
    role: UserRole = "customer"
  ) => {
    const demoUser: AppUser = {
      uid: "demo-" + Math.random().toString(36).substring(2, 9),
      displayName: name,
      email: email,
      photoURL: null,
      role: role,
      isDemo: true,
    };
    if (typeof window !== "undefined") {
      localStorage.setItem("brew_demo_user", JSON.stringify(demoUser));
    }
    setUser(demoUser);
    await syncSessionCookie(demoUser);
    setAuthModalOpen(false);
  };

  const signOutUser = async () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("brew_demo_user");
    }
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
    } catch {
      // Ignored
    }
    try {
      await signOut(auth);
    } catch {
      // Ignored if not configured
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isConfigured: isFirebaseConfigured,
        authModalOpen,
        setAuthModalOpen,
        authModalTab,
        setAuthModalTab,
        openAuthModal,
        closeAuthModal,
        signInWithEmail,
        signUpWithEmail,
        signInWithGoogle,
        loginWithStaffPin,
        resetPassword,
        signOutUser,
        demoSignIn,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
