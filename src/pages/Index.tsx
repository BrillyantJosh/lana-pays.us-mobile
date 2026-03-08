import { useState } from "react";
import TopBar from "@/components/TopBar";
import BottomNav from "@/components/BottomNav";
import MenuDrawer from "@/components/MenuDrawer";
import CashTab from "@/components/tabs/CashTab";
import WalletsTab from "@/components/tabs/WalletsTab";
import LanaTab from "@/components/tabs/LanaTab";

type Tab = "cash" | "wallets" | "lana";

const tabComponents: Record<Tab, React.FC> = {
  cash: CashTab,
  wallets: WalletsTab,
  lana: LanaTab,
};

const Index = () => {
  const [activeTab, setActiveTab] = useState<Tab>("wallets");
  const [menuOpen, setMenuOpen] = useState(false);

  const ActiveComponent = tabComponents[activeTab];

  return (
    <div className="min-h-screen bg-background">
      <TopBar onMenuOpen={() => setMenuOpen(true)} />
      <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />

      <main className="pt-14 pb-[var(--nav-height)]">
        <ActiveComponent />
      </main>

      <BottomNav active={activeTab} onChange={setActiveTab} />
    </div>
  );
};

export default Index;
