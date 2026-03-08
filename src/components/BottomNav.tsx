import { PoundSterling, Wallet } from "lucide-react";
import lanaIcon from "@/assets/lana-icon.png";

type Tab = "cash" | "wallets" | "lana";

interface BottomNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const tabs: { id: Tab; label: string; icon?: typeof Wallet; img?: string }[] = [
  { id: "cash", label: "Cash", icon: HandCoins },
  { id: "wallets", label: "Wallets", icon: Wallet },
  { id: "lana", label: "$Lana", img: lanaIcon },
];

const BottomNav = ({ active, onChange }: BottomNavProps) => {
  return (
    <nav className="fixed bottom-0 left-0 right-0 h-[var(--nav-height)] bg-card border-t border-border flex items-center justify-around px-2 z-50">
      {tabs.map(({ id, label, icon: Icon, img }) => {
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
            {Icon ? (
              <Icon className="w-6 h-6" strokeWidth={isActive ? 2.5 : 2} />
            ) : img ? (
              <img
                src={img}
                alt={label}
                className={`w-6 h-6 object-contain transition-opacity ${
                  isActive ? "opacity-100" : "opacity-60"
                }`}
              />
            ) : null}
            <span className="text-[10px] font-medium leading-none">{label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default BottomNav;
