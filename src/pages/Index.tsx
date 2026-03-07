import { useState } from "react";
import TopBar from "@/components/TopBar";
import BottomNav from "@/components/BottomNav";
import MenuDrawer from "@/components/MenuDrawer";
import RegisterTab from "@/components/tabs/RegisterTab";
import CheckTab from "@/components/tabs/CheckTab";
import DiscountTab from "@/components/tabs/DiscountTab";
import PayUsTab from "@/components/tabs/PayUsTab";

type Tab = "register" | "check" | "discount" | "payus";

const tabComponents: Record<Tab, React.FC> = {
  register: RegisterTab,
  check: CheckTab,
  discount: DiscountTab,
  payus: PayUsTab,
};

const Index = () => {
  const [activeTab, setActiveTab] = useState<Tab>("register");
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
