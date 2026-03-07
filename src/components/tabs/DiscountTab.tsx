import { Camera, Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DiscountTab = () => {
  return (
    <div className="flex flex-col gap-6 px-6 py-4">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
          <Percent className="w-7 h-7 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">Popust</h2>
          <p className="text-muted-foreground text-sm">Vnesi podatke računa za popust</p>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-5 space-y-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">Številka računa</Label>
          <Input
            placeholder="npr. 2024-001234"
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">Znesek (EUR)</Label>
          <Input
            type="number"
            placeholder="0.00"
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
      </div>

      <Button className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
        <Camera className="w-5 h-5" />
        Slikaj račun
      </Button>
    </div>
  );
};

export default DiscountTab;
