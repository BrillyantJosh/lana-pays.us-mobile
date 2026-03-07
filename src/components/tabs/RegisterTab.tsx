import { ScanLine, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";

const RegisterTab = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 px-6">
      <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center">
        <KeyRound className="w-10 h-10 text-primary" />
      </div>
      <div className="text-center space-y-2">
        <h2 className="font-display text-2xl font-bold text-foreground">Registracija</h2>
        <p className="text-muted-foreground text-sm max-w-[260px]">
          Skeniraj svoj Lana WIF Private Key za registracijo denarnice
        </p>
      </div>
      <Button className="w-full max-w-xs h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
        <ScanLine className="w-5 h-5" />
        Skeniraj WIF Key
      </Button>
    </div>
  );
};

export default RegisterTab;
