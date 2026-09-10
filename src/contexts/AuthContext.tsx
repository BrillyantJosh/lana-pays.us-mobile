import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { convertWifToIds } from '@/lib/crypto';
import i18n from '@/i18n';
import { checkExclusion, rememberedExclusion, exclusionFromRefusal, type ExclusionVerdict } from '@/lib/exclusion';
import { SESSION_KEY } from '@/lib/callerIdentity';
import { ExcludedScreen } from '@/components/ExcludedScreen';

declare global {
  interface Document {
    wasDiscarded?: boolean;
  }
}

interface UserSession {
  walletId: string;
  nostrHexId: string;
  nostrNpubId: string;
  privateKeyHex: string;
  profileName?: string;
  profileDisplayName?: string;
  profilePicture?: string;
  currency: string;
  expiresAt: number;
}

interface AuthContextType {
  session: UserSession | null;
  isLoading: boolean;
  login: (wif: string) => Promise<void>;
  logout: () => void;
  /** The standing commission decision against this person, or null. */
  excluded: ExclusionVerdict | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);


/**
 * What we were last told about whoever is already signed in on this device.
 *
 * Runs before the first render, so it must touch nothing but localStorage and
 * must never throw: private mode, a corrupt blob and a missing key all mean
 * "nothing remembered", which is not the same as "not excluded" — it only means
 * this device has not been told yet, and the live check right after will say.
 */
function rememberedForStoredSession(): ExclusionVerdict | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserSession;
    if (!parsed?.nostrHexId || !(parsed.expiresAt > Date.now())) return null;
    return rememberedExclusion(parsed.nostrHexId);
  } catch {
    return null;
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<UserSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // A commission gross-violation decision (KIND 87058) standing against the
  // person whose key is in this session. When set, the whole app is replaced by
  // ExcludedScreen below — no route, no cached tab, no partial page.
  //
  // Read SYNCHRONOUSLY, in the initialiser, from the session that is already in
  // localStorage. It used to start null and be corrected by the mount effect,
  // which runs AFTER React has painted — so a restored session saw the whole
  // till, with its balances and its buttons, for a frame before the door shut.
  // A person with nothing remembered still gets that frame; that is inherent,
  // and it is acceptable only because the server refuses every action anyway.
  const [excluded, setExcluded] = useState<ExclusionVerdict | null>(() => rememberedForStoredSession());

  // The gate lives HERE, at the session, not at the login form. This app grows a
  // session in four different ways — login(), the localStorage restore on mount,
  // Chrome's discarded-tab recovery, and a cross-tab storage event — and a new
  // decision reaches exactly the people who are already signed in, so a gate on
  // login() alone would be invisible to everyone it is meant to reach.
  const enforceExclusion = useCallback(async (candidate: UserSession | null): Promise<boolean> => {
    const hex = candidate?.nostrHexId;
    if (!hex) return true;
    const verdict = await checkExclusion(hex);
    if (!verdict) {
      setExcluded(null);
      return true;
    }
    setExcluded(verdict);
    // End the session: the door is closed, not merely covered over.
    setSession(null);
    try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
    return false;
  }, []);

  /**
   * Adopt a restored session, closing the door first if we already know about a
   * decision. The remembered verdict blocks instantly, with no network wait and
   * no flash of the dashboard; the live check right after can still lift it.
   */
  const adoptSession = useCallback((candidate: UserSession) => {
    const remembered = rememberedExclusion(candidate.nostrHexId);
    if (remembered) setExcluded(remembered);
    setSession(candidate);
    void enforceExclusion(candidate);
  }, [enforceExclusion]);

  const isSessionValid = (session: UserSession): boolean => {
    return session.expiresAt > Date.now();
  };

  const loadSessionFromStorage = useCallback((): UserSession | null => {
    try {
      const storedSession = localStorage.getItem(SESSION_KEY);
      if (storedSession) {
        const parsedSession: UserSession = JSON.parse(storedSession);
        if (isSessionValid(parsedSession)) {
          return parsedSession;
        } else {
          localStorage.removeItem(SESSION_KEY);
        }
      }
    } catch (error) {
      console.error('Failed to parse stored session:', error);
    }
    return null;
  }, []);

  // Load session on mount
  useEffect(() => {
    const loadedSession = loadSessionFromStorage();
    if (loadedSession) {
      adoptSession(loadedSession);
    }
    setIsLoading(false);
  }, [loadSessionFromStorage, adoptSession]);

  // Chrome Memory Saver recovery
  useEffect(() => {
    if (document.wasDiscarded) {
      const loadedSession = loadSessionFromStorage();
      if (loadedSession) {
        adoptSession(loadedSession);
      }
    }
  }, [loadSessionFromStorage, adoptSession]);

  // Save on background
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && session) {
        try {
          localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        } catch (e) {
          console.warn('Failed to save session:', e);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [session]);

  // Cross-tab sync
  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === SESSION_KEY) {
        if (event.newValue === null) {
          setSession(null);
        } else {
          try {
            const updatedSession: UserSession = JSON.parse(event.newValue);
            if (isSessionValid(updatedSession)) {
              // A second tab can re-seed a session we just cleared, so this path
              // is gated exactly like the other three.
              adoptSession(updatedSession);
            }
          } catch (e) {
            console.error('Failed to sync session:', e);
          }
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [adoptSession]);

  // Re-ask every 10 minutes, so a decision published while somebody is standing
  // at the till reaches them within the round, not at their next sign-in.
  const sessionRef = useRef<UserSession | null>(null);
  sessionRef.current = session;
  useEffect(() => {
    const id = setInterval(() => { void enforceExclusion(sessionRef.current); }, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [enforceExclusion]);

  const login = async (wif: string) => {
    try {
      const derivedIds = await convertWifToIds(wif);

      // Refuse a fresh sign-in too, so an excluded person never sees the
      // dashboard flash past on the way to the closed door. No error is thrown:
      // the screen that replaces the app IS the message, and a toast on top of
      // it would only say the same thing worse.
      const standing = await checkExclusion(derivedIds.nostrHexId);
      if (standing) {
        setExcluded(standing);
        setSession(null);
        try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
        return;
      }

      let profileName: string | undefined;
      let profileDisplayName: string | undefined;
      let profilePicture: string | undefined;
      let currency = 'GBP';

      // Verify a registered KIND 0 profile exists before granting access.
      // Fail-closed: if the profile cannot be CONFIRMED — because none exists
      // OR because the relays could not be reached (the request itself throws,
      // or the server returns { profile: null } on timeout) — login is rejected.
      // (Profile lookup runs server-side to avoid nostr-tools buffer issues in
      // the browser.)
      let profileData: { profile: any } | null = null;
      let profileRes: Response;
      try {
        profileRes = await fetch('/api/profile-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hex_id: derivedIds.nostrHexId }),
        });
      } catch (e) {
        // Could not reach our own server → unverifiable.
        console.warn('Profile lookup unreachable:', e);
        throw new Error(i18n.t('login.profileNotFound'));
      }

      // A rate-limited reply is plain text, so .json() below would throw and the
      // login would blame a missing profile — the wrong diagnosis entirely. Name
      // it, so the operator waits a minute instead of re-creating a profile that
      // is perfectly fine.
      if (profileRes.status === 429) {
        throw new Error(i18n.t('login.tooManyRequests'));
      }

      // Belt and braces: if our own check above could not reach the server but
      // the server itself knows about a decision, it answers 403 PERSON_EXCLUDED
      // here. Believe it rather than blaming a missing profile.
      if (profileRes.status === 403) {
        const refusal = exclusionFromRefusal(await profileRes.clone().json().catch(() => null));
        if (refusal) {
          setExcluded(refusal);
          setSession(null);
          try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
          return;
        }
      }

      try {
        profileData = await profileRes.json();
      } catch (e) {
        // Reached the server but could not parse the response → unverifiable.
        console.warn('Profile lookup failed:', e);
        throw new Error(i18n.t('login.profileNotFound'));
      }

      if (!profileData?.profile) {
        // Relays reachable but no KIND 0 found, OR relay query timed out — both
        // mean we cannot confirm a profile, so we refuse the login.
        throw new Error(i18n.t('login.profileNotFound'));
      }

      profileName = profileData.profile.name;
      profileDisplayName = profileData.profile.display_name;
      profilePicture = profileData.profile.picture;
      if (profileData.profile.currency) {
        currency = profileData.profile.currency.toUpperCase();
      }
      // Set UI language from KIND 0 profile — profile is the source of truth
      if (profileData.profile.lang) {
        try {
          const { changeLanguage } = await import('../i18n/index');
          changeLanguage(profileData.profile.lang);
        } catch {}
      }

      // Register user on backend
      try {
        await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hex_id: derivedIds.nostrHexId,
            npub: derivedIds.nostrNpubId,
            lana_address: derivedIds.walletId,
            display_name: profileName || profileDisplayName || null,   // KIND 0 `name` is the REAL name; display_name is a nickname
            picture: profilePicture || null,
          }),
        });
      } catch (e) {
        console.warn('Failed to register user on backend:', e);
      }

      const expiresAt = Date.now() + (8 * 60 * 60 * 1000); // 8 hours

      const userSession: UserSession = {
        walletId: derivedIds.walletId,
        nostrHexId: derivedIds.nostrHexId,
        nostrNpubId: derivedIds.nostrNpubId,
        privateKeyHex: derivedIds.privateKeyHex,
        profileName,
        profileDisplayName,
        profilePicture,
        currency,
        expiresAt,
      };

      setSession(userSession);
      localStorage.setItem(SESSION_KEY, JSON.stringify(userSession));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Login failed');
    }
  };

  const logout = () => {
    setSession(null);
    localStorage.removeItem(SESSION_KEY);
  };

  return (
    <AuthContext.Provider value={{ session, isLoading, login, logout, excluded }}>
      {excluded
        ? <ExcludedScreen verdict={excluded} lang={i18n.language?.startsWith('sl') ? 'sl' : 'en'} />
        : children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
