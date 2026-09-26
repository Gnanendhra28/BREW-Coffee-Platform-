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

export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
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
  signInWithEmail: (email: string, pass: string) => Promise<void>;
  signUpWithEmail: (email: string, pass: string, name?: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  demoSignIn: (name?: string, email?: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<"login" | "signup" | "reset">("login");

  // Load demo user or Firebase listener
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    queueMicrotask(() => {
      if (typeof window !== "undefined") {
        const storedDemo = localStorage.getItem("brew_demo_user");
        if (storedDemo) {
          try {
            setUser(JSON.parse(storedDemo));
            setLoading(false);
            return;
          } catch {
            localStorage.removeItem("brew_demo_user");
          }
        }
      }

      // If Firebase is initialized, listen for auth changes
      try {
        unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
          if (firebaseUser) {
            setUser({
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName,
              photoURL: firebaseUser.photoURL,
              isDemo: false,
            });
          } else {
            setUser((currentUser) => (currentUser?.isDemo ? currentUser : null));
          }
          setLoading(false);
        });
      } catch (err) {
        console.warn("Firebase Auth listener initialized with fallback", err);
        setLoading(false);
      }
    });

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

  const signInWithEmail = async (email: string, pass: string) => {
    if (!isFirebaseConfigured) {
      throw new Error("FIREBASE_NOT_CONFIGURED");
    }
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    if (typeof window !== "undefined") {
      localStorage.removeItem("brew_demo_user");
    }
    setUser({
      uid: cred.user.uid,
      email: cred.user.email,
      displayName: cred.user.displayName,
      photoURL: cred.user.photoURL,
      isDemo: false,
    });
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
    setUser({
      uid: cred.user.uid,
      email: cred.user.email,
      displayName: name || cred.user.displayName,
      photoURL: cred.user.photoURL,
      isDemo: false,
    });
    setAuthModalOpen(false);
  };

  const signInWithGoogle = async () => {
    if (!isFirebaseConfigured) {
      throw new Error("FIREBASE_NOT_CONFIGURED");
    }
    const cred = await signInWithPopup(auth, googleProvider);
    if (typeof window !== "undefined") {
      localStorage.removeItem("brew_demo_user");
    }
    setUser({
      uid: cred.user.uid,
      email: cred.user.email,
      displayName: cred.user.displayName,
      photoURL: cred.user.photoURL,
      isDemo: false,
    });
    setAuthModalOpen(false);
  };

  const resetPassword = async (email: string) => {
    if (!isFirebaseConfigured) {
      throw new Error("FIREBASE_NOT_CONFIGURED");
    }
    await sendPasswordResetEmail(auth, email);
  };

  const demoSignIn = (name = "Coffee Connoisseur", email = "coffee.lover@brew.cafe") => {
    const demoUser: AppUser = {
      uid: "demo-" + Math.random().toString(36).substring(2, 9),
      displayName: name,
      email: email,
      photoURL: null,
      isDemo: true,
    };
    if (typeof window !== "undefined") {
      localStorage.setItem("brew_demo_user", JSON.stringify(demoUser));
    }
    setUser(demoUser);
    setAuthModalOpen(false);
  };

  const signOutUser = async () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("brew_demo_user");
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
