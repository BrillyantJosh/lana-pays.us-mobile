import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { convertWifToIds } from '@/lib/crypto';
import { SimplePool } from 'nostr-tools';

declare global {
  interface Document {
    wasDiscarded?: boolean;
  }
}

interface UserSession {
  lanaPrivateKey: string;
  walletId: string;
  nostrHexId: string;
  nostrNpubId: string;
  nostrPrivateKey: string;
  profileName?: string;
  profileDisplayName?: string;
  profilePicture?: string;
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
const LANA_RELAYS = [
  'wss://relay.lanavault.space',
  'wss://relay.lanacoin-eternity.com'
];

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

      // Fetch KIND 0 profile from relays
      const pool = new SimplePool();
      try {
        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), 5000)
        );

        const profileEvent = await Promise.race([
          pool.get(LANA_RELAYS, {
            kinds: [0],
            authors: [derivedIds.nostrHexId],
            limit: 1
          }),
          timeoutPromise
        ]);

        if (profileEvent && profileEvent.kind === 0) {
          try {
            const content = JSON.parse(profileEvent.content);
            profileName = content.name;
            profileDisplayName = content.display_name;
            profilePicture = content.picture;
          } catch (e) {
            console.warn('Could not parse profile content:', e);
          }
        }
      } catch (profileError) {
        if (profileError instanceof Error && profileError.message === 'TIMEOUT') {
          console.warn('Profile fetch timed out, continuing without profile data');
        }
      } finally {
        pool.close(LANA_RELAYS);
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

      const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days

      const userSession: UserSession = {
        lanaPrivateKey: derivedIds.lanaPrivateKey,
        walletId: derivedIds.walletId,
        nostrHexId: derivedIds.nostrHexId,
        nostrNpubId: derivedIds.nostrNpubId,
        nostrPrivateKey: derivedIds.nostrPrivateKey,
        profileName,
        profileDisplayName,
        profilePicture,
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
