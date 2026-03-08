import { Menu } from "lucide-react";
import lanaLogo from "@/assets/lana-icon-green.png";

interface TopBarProps {
  onMenuOpen: () => void;
}

const TopBar = ({ onMenuOpen }: TopBarProps) => {
  return (
    <header className="fixed top-0 left-0 right-0 h-14 bg-card/90 backdrop-blur-md border-b border-border flex items-center justify-between px-4 z-50">
      <div className="flex items-center gap-2">
        <img src={lanaLogo} alt="Lana" className="w-8 h-8 object-contain" />
        <h1 className="font-display text-lg font-bold text-foreground">
          Lana <span className="text-primary">Pays.Us</span>
        </h1>
      </div>
      <button
        onClick={onMenuOpen}
        className="w-10 h-10 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      >
        <Menu className="w-5 h-5" />
      </button>
    </header>
  );
};

export default TopBar;
