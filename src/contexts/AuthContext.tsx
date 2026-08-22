import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { convertWifToIds } from '@/lib/crypto';
import i18n from '@/i18n';

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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_KEY = 'lana_pays_session';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<UserSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
      setSession(loadedSession);
    }
    setIsLoading(false);
  }, [loadSessionFromStorage]);

  // Chrome Memory Saver recovery
  useEffect(() => {
    if (document.wasDiscarded) {
      const loadedSession = loadSessionFromStorage();
      if (loadedSession) {
        setSession(loadedSession);
      }
    }
  }, [loadSessionFromStorage]);

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
              setSession(updatedSession);
            }
          } catch (e) {
            console.error('Failed to sync session:', e);
          }
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const login = async (wif: string) => {
    try {
      const derivedIds = await convertWifToIds(wif);
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
    <AuthContext.Provider value={{ session, isLoading, login, logout }}>
      {children}
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
