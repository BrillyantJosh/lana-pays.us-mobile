import { useState } from "react";
import TopBar from "@/components/TopBar";
import BottomNav from "@/components/BottomNav";
import MenuDrawer from "@/components/MenuDrawer";
import CashTab from "@/components/tabs/CashTab";
import WalletsTab from "@/components/tabs/WalletsTab";
import LanaTab from "@/components/tabs/LanaTab";

type Tab = "cash" | "wallets" | "lana";

const Index = () => {
  const [activeTab, setActiveTab] = useState<Tab>("wallets");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [lanaPaymentRequest, setLanaPaymentRequest] = useState<{ walletAddress: string } | null>(null);

  const handlePayWithCash = (walletId: string) => {
    setSelectedWallet(walletId);
    setActiveTab("cash");
  };

  const handlePayWithLana = (walletAddress: string) => {
    setLanaPaymentRequest({ walletAddress });
    setActiveTab("lana");
  };

  const handleTabChange = (tab: Tab) => {
    setSelectedWallet(null);
    setLanaPaymentRequest(null);
    setActiveTab(tab);
  };

  return (
    <div className="min-h-screen bg-background">
      <TopBar onMenuOpen={() => setMenuOpen(true)} />
      <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />

      <main className="pt-14 pb-[var(--nav-height)]">
        {activeTab === "wallets" && (
          <WalletsTab onPayWithCash={handlePayWithCash} onPayWithLana={handlePayWithLana} />
        )}
        {activeTab === "cash" && (
          <CashTab selectedWallet={selectedWallet} onClearWallet={() => setSelectedWallet(null)} />
        )}
        {activeTab === "lana" && (
          <LanaTab paymentRequest={lanaPaymentRequest} onClearRequest={() => setLanaPaymentRequest(null)} />
        )}
      </main>

      <BottomNav active={activeTab} onChange={handleTabChange} />
    </div>
  );
};

export default Index;
