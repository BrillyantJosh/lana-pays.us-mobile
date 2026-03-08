import { X, Settings, HelpCircle, LogOut, Shield } from "lucide-react";

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
}

const menuItems = [
  { label: "Settings", icon: Settings },
  { label: "Security", icon: Shield },
  { label: "Help", icon: HelpCircle },
  { label: "Sign Out", icon: LogOut },
];

const MenuDrawer = ({ open, onClose }: MenuDrawerProps) => {
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
        <div className="p-3 flex flex-col gap-1">
          {menuItems.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-foreground hover:bg-secondary transition-colors text-sm font-medium"
            >
              <Icon className="w-5 h-5 text-muted-foreground" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
};

export default MenuDrawer;
