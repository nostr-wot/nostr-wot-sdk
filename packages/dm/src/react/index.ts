"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  initDMSession,
  subscribeInbox,
  sendDM,
  persistDMSession,
  _sessionState,
  type DMConversation,
  type DMMessage,
  type DMSession,
} from "../cache";
import type { NostrSigner } from "@nostr-wot/signers";
import type { DMStorage, SendDMOptions } from "../cache/types";

export interface UseDMSessionArgs {
  signer: NostrSigner | null;
  relays: string[];
  storage?: DMStorage;
  discoverInboxRelays?: boolean;
}

/**
 * Bootstrap a DM session for the active signer. Returns the session
 * handle (or null while initializing) plus a `sendDM` callback bound to
 * this session. Auto-subscribes to the inbox on mount, tears down on
 * unmount.
 */
export function useDMSession(args: UseDMSessionArgs): {
  session: DMSession | null;
  sendDM: (partner: string, content: string, opts?: SendDMOptions) => Promise<void>;
} {
  const [session, setSession] = useState<DMSession | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!args.signer) {
      setSession(null);
      return;
    }
    void (async () => {
      const myPubkey = await args.signer!.getPublicKey();
      if (cancelled) return;
      const built = await initDMSession({
        myPubkey,
        signer: args.signer!,
        relays: args.relays,
        ...(args.storage ? { storage: args.storage } : {}),
        ...(args.discoverInboxRelays !== undefined
          ? { discoverInboxRelays: args.discoverInboxRelays }
          : {}),
      });
      if (cancelled) return;
      setSession(built);
      teardownRef.current = subscribeInbox(built);
    })();
    return () => {
      cancelled = true;
      teardownRef.current?.();
      teardownRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.signer]);

  const send = useMemo(() => {
    return async (partner: string, content: string, opts?: SendDMOptions) => {
      if (!session) throw new Error("DM session not yet initialized");
      await sendDM(session, partner, content, opts);
      void persistDMSession(session);
    };
  }, [session]);

  return { session, sendDM: send };
}

/**
 * Subscribe to the message list for one partner. Re-renders whenever a
 * new message lands in that thread.
 */
export function useThread(myPubkey: string | null, partnerPubkey: string | null): DMMessage[] {
  const state = myPubkey ? _sessionState(myPubkey) : null;
  return useSyncExternalStore(
    (cb) => {
      if (!state || !partnerPubkey) return () => {};
      return state.messages.subscribe(partnerPubkey, () => cb());
    },
    () => {
      if (!state || !partnerPubkey) return [];
      return state.messages.get(partnerPubkey).value ?? [];
    },
    () => [],
  );
}

/**
 * Subscribe to the conversation list (one entry per distinct partner,
 * sorted by lastMessageAt desc).
 */
export function useConversations(myPubkey: string | null): DMConversation[] {
  const state = myPubkey ? _sessionState(myPubkey) : null;
  return useSyncExternalStore(
    (cb) => {
      if (!state) return () => {};
      return state.conversations.subscribe(state.myPubkey, () => cb());
    },
    () => {
      if (!state) return [];
      return state.conversations.get(state.myPubkey).value ?? [];
    },
    () => [],
  );
}
