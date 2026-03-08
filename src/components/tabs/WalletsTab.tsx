import { ScanLine, KeyRound, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";

const WalletsTab = () => {
  return (
    <div className="flex flex-col gap-8 px-6 py-4">
      {/* Register Wallet */}
      <div className="flex flex-col items-center gap-5">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center">
          <KeyRound className="w-8 h-8 text-primary" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="font-display text-xl font-bold text-foreground">Register Wallet</h2>
          <p className="text-muted-foreground text-sm max-w-[260px]">
            Scan your Lana WIF Private Key to register your wallet
          </p>
        </div>
        <Button className="w-full max-w-xs h-13 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
          <ScanLine className="w-5 h-5" />
          Scan WIF Key
        </Button>
      </div>

      <div className="border-t border-border" />

      {/* Check Balance */}
      <div className="flex flex-col items-center gap-5">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center">
          <Wallet className="w-8 h-8 text-primary" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="font-display text-xl font-bold text-foreground">Check Balance</h2>
          <p className="text-muted-foreground text-sm max-w-[260px]">
            Scan your Lana Wallet ID to check your balance
          </p>
        </div>
        <Button className="w-full max-w-xs h-13 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
          <ScanLine className="w-5 h-5" />
          Scan Wallet ID
        </Button>
      </div>
    </div>
  );
};

export default WalletsTab;
