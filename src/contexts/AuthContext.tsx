import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { convertWifToIds } from '@/lib/crypto';

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

      // Fetch KIND 0 profile via server (avoids nostr-tools buffer issues in browser)
      try {
        const profileRes = await fetch('/api/profile-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hex_id: derivedIds.nostrHexId }),
        });
        const profileData = await profileRes.json();
        if (profileData.profile) {
          profileName = profileData.profile.name;
          profileDisplayName = profileData.profile.display_name;
          profilePicture = profileData.profile.picture;
          if (profileData.profile.currency) {
            currency = profileData.profile.currency.toUpperCase();
          }
          // Set UI language from KIND 0 profile (only if no manual override in localStorage)
          if (profileData.profile.lang && !localStorage.getItem('lang')) {
            try {
              const { changeLanguage } = await import('../i18n/index');
              changeLanguage(profileData.profile.lang);
            } catch {}
          }
        }
      } catch (e) {
        console.warn('Profile lookup failed, continuing without profile data:', e);
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
            display_name: profileDisplayName || profileName || null,
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
