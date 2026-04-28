"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
  localStorageSignerStorage,
  type SignerStorage,
} from "./signer-storage";

const SignerStorageContext = createContext<SignerStorage>(
  localStorageSignerStorage,
);

export function SignerStorageProvider({
  storage,
  children,
}: {
  storage: SignerStorage;
  children: ReactNode;
}) {
  return (
    <SignerStorageContext.Provider value={storage}>
      {children}
    </SignerStorageContext.Provider>
  );
}

/**
 * Read the active `SignerStorage`. Defaults to plaintext localStorage
 * when no provider is mounted (so login methods still work in
 * minimal apps).
 */
export function useSignerStorage(): SignerStorage {
  return useContext(SignerStorageContext);
}
