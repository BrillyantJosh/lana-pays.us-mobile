/**
 * Sign-in with the key saved encrypted on this device, and the choice to save it — the same as LetsBalance.world
 * (Brilly, 25. 11. 2026). Saving and removing happen ONLY on the sign-in page; the locked screen only unlocks.
 *
 * The vault password is never offered to the browser's password manager (autoComplete off): it is what protects the
 * key, and it must not sit next to it.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Fingerprint, Loader2, Lock, Trash2 } from 'lucide-react';
import { VaultError, forgetVault, passkeyAvailable, vaultInfo, type VaultInfo, type VaultMethod } from '@/lib/keyVault';
import type { SaveKeyChoice } from '@/contexts/AuthContext';

const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;

/** A vault problem (or any other error) in the reader's language. */
export function useVaultErrorText() {
  const { t } = useTranslation();
  return (error: unknown): string => {
    if (error instanceof VaultError) return t(`vault.error.${error.code}`, { defaultValue: t('vault.error.unlock_failed') });
    return error instanceof Error ? error.message : String(error);
  };
}

const inputClass =
  'w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50';

/**
 * Unlock the key saved on this device. `onUnlock(password)` signs in with it (AuthContext.unlock); `allowRemove`
 * only on the sign-in page.
 */
export function SavedKeyUnlock({
  info, label, onUnlock, allowRemove = false, onRemoved,
}: {
  info: VaultInfo;
  label?: string;
  onUnlock: (password: string) => Promise<void>;
  allowRemove?: boolean;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const explain = useVaultErrorText();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'unlock' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const unlock = async () => {
    setError(null);
    setBusy('unlock');
    try {
      await onUnlock(password);
      setPassword('');
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy('remove');
    try {
      await forgetVault(password);
      setPassword('');
      setConfirmRemove(false);
      onRemoved?.();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Lock className="w-4 h-4 mt-0.5 text-blue-700 dark:text-blue-300 shrink-0" />
        <div className="text-sm">
          <p className="font-medium text-gray-900 dark:text-gray-100">{t('vault.savedTitle')}</p>
          <p className="text-gray-600 dark:text-gray-400">
            {label ? `${label} · ` : ''}<span className="font-mono">{short(info.pubkey)}</span>
          </p>
        </div>
      </div>

      <form
        className="space-y-2"
        onSubmit={(e) => { e.preventDefault(); void (confirmRemove ? remove() : unlock()); }}
      >
        {info.method === 'password' && (
          <input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('vault.passwordPlaceholder')}
            aria-label={t('vault.password')}
            disabled={busy !== null}
            className={inputClass}
          />
        )}
        {!confirmRemove ? (
          <button
            type="submit"
            disabled={busy !== null || (info.method === 'password' && !password)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium"
          >
            {busy === 'unlock' ? <Loader2 className="w-4 h-4 animate-spin" /> : info.method === 'passkey' ? <Fingerprint className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
            {info.method === 'passkey' ? t('vault.unlockPasskey') : t('vault.unlockPassword')}
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-red-700 dark:text-red-400">{t('vault.removeConfirmText')}</p>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy !== null || (info.method === 'password' && !password)}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm font-medium"
              >
                {busy === 'remove' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                {t('vault.removeConfirm')}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmRemove(false); setError(null); }}
                disabled={busy !== null}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-300"
              >
                {t('vault.cancel')}
              </button>
            </div>
          </div>
        )}
      </form>

      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}

      {allowRemove && !confirmRemove && (
        <button
          type="button"
          onClick={() => { setConfirmRemove(true); setError(null); }}
          disabled={busy !== null}
          className="text-xs text-gray-500 dark:text-gray-400 underline hover:text-red-600"
        >
          {t('vault.remove')}
        </button>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('vault.unlockHint')}</p>
    </div>
  );
}

/** "Save my key encrypted on this device" on the sign-in form. Returns the choice, or null (not saving). */
export function useSaveKeyChoice(defaultOn: boolean) {
  const canPasskey = passkeyAvailable();
  const [save, setSave] = useState(defaultOn && canPasskey);
  const [method, setMethod] = useState<VaultMethod>(canPasskey ? 'passkey' : 'password');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const choice: SaveKeyChoice | null = save ? { method, password, repeat } : null;
  return { canPasskey, save, setSave, method, setMethod, password, setPassword, repeat, setRepeat, choice, clear: () => { setPassword(''); setRepeat(''); } };
}

export function SaveKeyOptions({ state, disabled }: { state: ReturnType<typeof useSaveKeyChoice>; disabled?: boolean }) {
  const { t } = useTranslation();
  const { canPasskey, save, setSave, method, setMethod, password, setPassword, repeat, setRepeat } = state;
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          id="saveKey"
          checked={save}
          onChange={(e) => setSave(e.target.checked)}
          disabled={disabled}
          className="mt-0.5 w-4 h-4 text-blue-600 rounded border-gray-300 dark:border-gray-600 focus:ring-blue-500"
        />
        <label htmlFor="saveKey" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          {t('vault.saveLabel')}
          <span className="block text-xs text-gray-500 dark:text-gray-400">{save ? t('vault.saveHint') : t('vault.noSaveHint')}</span>
        </label>
      </div>
      {save && (
        <div className="ml-6 space-y-2">
          <div className="flex flex-col gap-1 text-sm text-gray-700 dark:text-gray-300">
            <label className={`flex items-center gap-2 ${canPasskey ? 'cursor-pointer' : 'opacity-50'}`}>
              <input type="radio" name="saveMethod" checked={method === 'passkey'} onChange={() => setMethod('passkey')} disabled={disabled || !canPasskey} />
              {t('vault.methodPasskey')}
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="saveMethod" checked={method === 'password'} onChange={() => setMethod('password')} disabled={disabled} />
              {t('vault.methodPassword')}
            </label>
          </div>
          {method === 'password' && (
            <div className="space-y-2">
              <input
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('vault.newPassword')}
                aria-label={t('vault.newPassword')}
                disabled={disabled}
                className={inputClass}
              />
              <input
                type="password"
                autoComplete="off"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                placeholder={t('vault.repeatPassword')}
                aria-label={t('vault.repeatPassword')}
                disabled={disabled}
                className={inputClass}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('vault.passwordRule')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The saved key on this device, read once per render; a broken record reads as none (and is left alone). */
export function useVaultInfo(): [VaultInfo | null, () => void] {
  const [, bump] = useState(0);
  return [vaultInfo(), () => bump((n) => n + 1)];
}
