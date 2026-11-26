/**
 * The key remembered on this device — kept SIMPLE (Brilly, 26. 11. 2026: »postopek vstopa je preveč zakompliciran …
 * poenostavi«). The sign-in is what it always was: scan or type the key. Beside it, two things only:
 *   - a box »Remember me on this device (passkey)« — the key is then encrypted on this device and opened by the
 *     passkey (Face ID, fingerprint; iCloud Keychain on Apple devices), the same as LetsBalance.world;
 *   - when a key is remembered here, one button »Sign in with passkey« above the form.
 * No passwords: a key saved with a password (25.–26. 11.) is no longer offered — sign in with the key and tick the
 * box, and it is replaced. A failed save never stands between a person and their sign-in.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import { Fingerprint, Loader2 } from 'lucide-react';
import { VaultError, forgetVault, passkeyAvailable, passkeyPrfSupported, vaultInfo, type VaultInfo } from '@/lib/keyVault';
import type { SaveKeyChoice } from '@/contexts/AuthContext';

/** A vault problem (or any other error) in the reader's language. */
export function useVaultErrorText() {
  const { t } = useTranslation();
  return (error: unknown): string => {
    if (error instanceof VaultError) return t(`vault.error.${error.code}`, { defaultValue: t('vault.error.unlock_failed') });
    return error instanceof Error ? error.message : String(error);
  };
}

/** One button: sign in with the key remembered on this device. `allowRemove` only on the sign-in page. */
export function SavedKeyUnlock({
  info: _info, label, onUnlock, allowRemove = false, onRemoved,
}: {
  info: VaultInfo;
  label?: string;
  onUnlock: (password: string) => Promise<void>;
  allowRemove?: boolean;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const explain = useVaultErrorText();
  const [busy, setBusy] = useState<'unlock' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: 'unlock' | 'remove') => {
    setError(null);
    setBusy(what);
    try {
      if (what === 'unlock') await onUnlock('');
      else { await forgetVault(''); onRemoved?.(); }
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void run('unlock')}
        disabled={busy !== null}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium"
      >
        {busy === 'unlock' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Fingerprint className="w-5 h-5" />}
        <span>{t('vault.unlockPasskey')}{label ? ` · ${label}` : ''}</span>
      </button>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {allowRemove && (
        <button
          type="button"
          onClick={() => void run('remove')}
          disabled={busy !== null}
          className="block mx-auto text-xs text-gray-500 dark:text-gray-400 underline hover:text-red-600"
        >
          {t('vault.remove')}
        </button>
      )}
    </div>
  );
}

/** »Remember me on this device (passkey)« — unticked until the person ticks it; never offered where it cannot work. */
export function useSaveKeyChoice(_defaultOn = false) {
  const [canPasskey, setCanPasskey] = useState(passkeyAvailable());
  const [save, setSave] = useState(false);
  useEffect(() => {
    let alive = true;
    // A browser that says its passkeys cannot give the secret (no PRF): the box is not shown at all.
    void passkeyPrfSupported().then((prf) => {
      if (!alive || prf !== false) return;
      setCanPasskey(false);
      setSave(false);
    });
    return () => { alive = false; };
  }, []);
  const choice: SaveKeyChoice | null = save && canPasskey ? { method: 'passkey' } : null;
  return { canPasskey, save, setSave, choice, clear: () => { /* nothing typed to clear */ } };
}

export function SaveKeyOptions({ state, disabled }: { state: ReturnType<typeof useSaveKeyChoice>; disabled?: boolean }) {
  const { t } = useTranslation();
  if (!state.canPasskey) return null;
  return (
    <label className="flex items-start gap-2 cursor-pointer text-left">
      <input
        type="checkbox"
        checked={state.save}
        onChange={(e) => state.setSave(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 w-4 h-4 shrink-0 text-blue-600 rounded border-gray-300 dark:border-gray-600 focus:ring-blue-500"
      />
      <span className="text-sm text-gray-700 dark:text-gray-300">
        {t('vault.saveLabel')}
        <span className="block text-xs text-gray-500 dark:text-gray-400">{t('vault.saveHint')}</span>
      </span>
    </label>
  );
}

/** The key remembered on this device — only one a passkey opens; a password-saved one (25.–26. 11.) reads as none. */
export function useVaultInfo(): [VaultInfo | null, () => void] {
  const [, bump] = useState(0);
  const info = vaultInfo();
  return [info?.method === 'passkey' ? info : null, () => bump((n) => n + 1)];
}

/**
 * A save that failed while the sign-in went through (26. 11. 2026: saving never stands between a person and their
 * sign-in). Said once, plainly, after the sign-in.
 */
export function tellKeyNotSaved(error: unknown): void {
  const t = i18next.t.bind(i18next);
  const why = error instanceof VaultError
    ? t(`vault.error.${error.code}`, { defaultValue: t('vault.error.unlock_failed') })
    : error instanceof Error ? error.message : String(error);
  window.setTimeout(() => { try { window.alert(`${t('vault.notSaved')} ${why}`); } catch { /* no dialogs here */ } }, 0);
}
