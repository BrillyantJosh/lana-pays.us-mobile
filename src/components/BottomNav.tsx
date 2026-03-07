import { UserPlus, Search, Percent, CreditCard } from "lucide-react";

type Tab = "register" | "check" | "discount" | "payus";

interface BottomNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const tabs = [
  { id: "register" as Tab, label: "Register", icon: UserPlus },
  { id: "check" as Tab, label: "Check", icon: Search },
  { id: "discount" as Tab, label: "Discount", icon: Percent },
  { id: "payus" as Tab, label: "Pay.Us", icon: CreditCard },
];

const BottomNav = ({ active, onChange }: BottomNavProps) => {
  return (
    <nav className="fixed bottom-0 left-0 right-0 h-[var(--nav-height)] bg-card border-t border-border flex items-center justify-around px-2 z-50">
      {tabs.map(({ id, label, icon: Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`flex flex-col items-center gap-1 py-2 px-3 rounded-xl transition-all duration-200 ${
              isActive
                ? "text-primary bg-secondary scale-105"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
            <span className="text-[10px] font-medium leading-none">{label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default BottomNav;
