/**
 * Remembered on this device, but the key is not in this tab (a reload, or 15 minutes unused with a saved key):
 * unlock the saved key in place, and the page opens where it was (Brilly, 25. 11. 2026 — the same as LetsBalance).
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SavedKeyUnlock } from '@/components/KeyVaultPanel';
import type { VaultInfo } from '@/lib/keyVault';

export function LockedScreen({
  vault, label, onUnlock, onSignOut,
}: { vault: VaultInfo; label?: string; onUnlock: (password: string) => Promise<void>; onSignOut: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-700 p-8 space-y-5">
        <div className="text-center">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{t('vault.lockedTitle')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('vault.lockedText')}</p>
        </div>
        <SavedKeyUnlock info={vault} label={label} onUnlock={onUnlock} />
        <div className="flex justify-between text-sm">
          <Link to="/login" className="text-blue-600 dark:text-blue-400 underline">{t('vault.otherKey')}</Link>
          <button type="button" onClick={onSignOut} className="text-gray-600 dark:text-gray-400 underline">{t('vault.signOut')}</button>
        </div>
      </div>
    </div>
  );
}
