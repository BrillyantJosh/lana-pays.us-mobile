import { useState } from "react";
import { X, HelpCircle, LogOut, Store, UserPen, Copy, Check, History, Wallet } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
  onEditProfile?: () => void;
}

const MenuDrawer = ({ open, onClose, onEditProfile }: MenuDrawerProps) => {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const handleSignOut = () => {
    logout();
    onClose();
    navigate('/login');
  };

  const handleEditProfile = () => {
    onClose();
    onEditProfile?.();
  };

  const menuItems = [
    { label: "Profile", icon: UserPen, action: handleEditProfile },
    { label: "Shop", icon: Store, action: () => { onClose(); window.open('https://shop.lanapays.us', '_blank'); } },
    { label: "Check Wallet", icon: Wallet, action: () => { onClose(); window.open('https://check.lanapays.us', '_blank'); } },
    { label: "History", icon: History, action: () => { onClose(); window.open('https://brain.lanapays.us', '_blank'); } },
    { label: "Help", icon: HelpCircle, action: () => {} },
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
          <span className="font-display font-semibold text-foreground">Menu</span>
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
              {session.profileDisplayName || session.profileName || 'Lana User'}
            </p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(session.nostrHexId).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="flex items-center gap-1.5 mt-1 group"
              title="Copy Nostr Hex ID"
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

          <div className="border-t border-border my-2" />

          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-destructive hover:bg-destructive/10 transition-colors text-sm font-medium"
          >
            <LogOut className="w-5 h-5" />
            Sign Out
          </button>
        </div>
      </div>
    </>
  );
};

export default MenuDrawer;
