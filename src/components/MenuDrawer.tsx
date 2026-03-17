import { X, HelpCircle, LogOut, Search, Store, UserPen } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
  onCheckWallet?: () => void;
  onEditProfile?: () => void;
}

const MenuDrawer = ({ open, onClose, onCheckWallet, onEditProfile }: MenuDrawerProps) => {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = () => {
    logout();
    onClose();
    navigate('/login');
  };

  const handleCheckWallet = () => {
    onClose();
    onCheckWallet?.();
  };

  const handleEditShop = () => {
    onClose();
    window.open('https://shop.lanapays.us', '_blank');
  };

  const handleEditProfile = () => {
    onClose();
    onEditProfile?.();
  };

  const menuItems = [
    { label: "Edit Profile", icon: UserPen, action: handleEditProfile },
    { label: "Check Wallet", icon: Search, action: handleCheckWallet },
    { label: "Edit Shop", icon: Store, action: handleEditShop },
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
            <p className="text-xs text-muted-foreground truncate">
              {session.nostrNpubId.slice(0, 20)}...
            </p>
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
