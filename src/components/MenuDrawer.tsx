import { useState, useEffect } from "react";
import { X, HelpCircle, LogOut, Store, UserPen, Copy, Check, History, Wallet, Globe, Shield, Users } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { changeLanguage, getCurrentLanguage } from "@/i18n";

const LANGUAGES = [
  { code: 'en', native: 'English' },
  { code: 'sl', native: 'Slovenščina' },
  { code: 'hu', native: 'Magyar' },
  { code: 'it', native: 'Italiano' },
  { code: 'es', native: 'Español' },
  { code: 'pl', native: 'Polski' },
  { code: 'pt', native: 'Português' },
  { code: 'de', native: 'Deutsch' },
  { code: 'hr', native: 'Hrvatski' },
  { code: 'sr', native: 'Srpski' },
  { code: 'ru', native: 'Русский' },
  { code: 'zh', native: '中文' },
];

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
  onEditProfile?: () => void;
  onRegularCustomers?: () => void;
}

const MenuDrawer = ({ open, onClose, onEditProfile, onRegularCustomers }: MenuDrawerProps) => {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!session?.nostrHexId || !open) return;
    fetch(`/api/admin/check?hex_id=${session.nostrHexId}`)
      .then(r => r.json())
      .then(d => setIsAdmin(d.isAdmin))
      .catch(() => setIsAdmin(false));
  }, [session?.nostrHexId, open]);

  const handleSignOut = () => {
    logout();
    onClose();
    navigate('/login');
  };

  const handleEditProfile = () => {
    onClose();
    onEditProfile?.();
  };

  const handleLanguageSelect = (code: string) => {
    changeLanguage(code);
    setShowLangPicker(false);
  };

  const currentLang = getCurrentLanguage();
  const currentLangName = LANGUAGES.find(l => l.code === currentLang)?.native || 'English';

  const menuItems = [
    { label: t('menu.profile'), icon: UserPen, action: handleEditProfile },
    { label: t('menu.shop'), icon: Store, action: () => { onClose(); window.open('https://shop.lanapays.us', '_blank'); } },
    { label: t('menu.checkWallet'), icon: Wallet, action: () => { onClose(); window.open('https://check.lanapays.us', '_blank'); } },
    { label: t('menu.regularCustomers'), icon: Users, action: () => { onClose(); onRegularCustomers?.(); } },
    { label: t('menu.history'), icon: History, action: () => { onClose(); window.open('https://brain.lanapays.us', '_blank'); } },
    { label: t('menu.help'), icon: HelpCircle, action: () => {} },
  ];

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed inset-0 bg-foreground/20 backdrop-blur-sm z-[60] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />
      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 h-full w-72 bg-card border-l border-border z-[70] transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <span className="font-display font-semibold text-foreground">{t('menu.title')}</span>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* User info */}
        {session && (
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-medium text-foreground truncate">
              {session.profileDisplayName || session.profileName || t('menu.defaultUser')}
            </p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(session.nostrHexId).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="flex items-center gap-1.5 mt-1 group"
              title={t('menu.copyHexId')}
            >
              <p className="text-xs text-muted-foreground truncate font-mono">
                {session.nostrHexId.slice(0, 12)}...{session.nostrHexId.slice(-8)}
              </p>
              {copied ? (
                <Check className="w-3 h-3 text-green-500 shrink-0" />
              ) : (
                <Copy className="w-3 h-3 text-muted-foreground group-hover:text-foreground shrink-0 transition-colors" />
              )}
            </button>
          </div>
        )}

        <div className="p-3 flex flex-col gap-1">
          {menuItems.map(({ label, icon: Icon, action }) => (
            <button
              key={label}
              onClick={action}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-foreground hover:bg-secondary transition-colors text-sm font-medium"
            >
              <Icon className="w-5 h-5 text-muted-foreground" />
              {label}
            </button>
          ))}

          {/* Admin link (only for admins) */}
          {isAdmin && (
            <button
              onClick={() => { onClose(); navigate('/admin'); }}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-primary hover:bg-primary/10 transition-colors text-sm font-medium"
            >
              <Shield className="w-5 h-5" />
              Admin
            </button>
          )}

          {/* Language selector */}
          <button
            onClick={() => setShowLangPicker(!showLangPicker)}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-foreground hover:bg-secondary transition-colors text-sm font-medium"
          >
            <Globe className="w-5 h-5 text-muted-foreground" />
            <span className="flex-1 text-left">{t('menu.language')}</span>
            <span className="text-xs text-muted-foreground">{currentLangName}</span>
          </button>

          {showLangPicker && (
            <div className="ml-8 mr-2 mb-1 rounded-xl bg-secondary/50 border border-border overflow-hidden max-h-64 overflow-y-auto">
              {LANGUAGES.map(lang => (
                <button
                  key={lang.code}
                  onClick={() => handleLanguageSelect(lang.code)}
                  className={`w-full flex items-center justify-between px-4 py-2.5 text-sm transition-colors ${
                    lang.code === currentLang
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-secondary'
                  }`}
                >
                  <span>{lang.native}</span>
                  {lang.code === currentLang && <Check className="w-4 h-4 text-primary" />}
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-border my-2" />

          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-destructive hover:bg-destructive/10 transition-colors text-sm font-medium"
          >
            <LogOut className="w-5 h-5" />
            {t('menu.signOut')}
          </button>
        </div>
      </div>
    </>
  );
};

export default MenuDrawer;
