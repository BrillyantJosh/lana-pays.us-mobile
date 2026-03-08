import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import lanaIcon from "@/assets/lana-icon.png";

const LanaTab = () => {
  return (
    <div className="flex flex-col gap-6 px-6 py-4">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
          <img src={lanaIcon} alt="Lana" className="w-7 h-7 object-contain" />
        </div>
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">$Lana</h2>
          <p className="text-muted-foreground text-sm">Enter payment details</p>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-5 space-y-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">Invoice Number</Label>
          <Input
            placeholder="e.g. 2024-001234"
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">Amount (EUR)</Label>
          <Input
            type="number"
            placeholder="0.00"
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
      </div>

      <Button className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
        <Camera className="w-5 h-5" />
        Scan Invoice
      </Button>
    </div>
  );
};

export default LanaTab;
