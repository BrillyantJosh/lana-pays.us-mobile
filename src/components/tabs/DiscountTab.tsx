import { useTranslation } from 'react-i18next';
import { Camera, Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DiscountTab = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6 px-6 py-4">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
          <Percent className="w-7 h-7 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">{t('discount.title')}</h2>
          <p className="text-muted-foreground text-sm">{t('discount.subtitle')}</p>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-5 space-y-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">{t('cash.invoiceNumber')}</Label>
          <Input
            placeholder={t('cash.invoicePlaceholder')}
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">{t('cash.amount', { symbol: 'EUR' })}</Label>
          <Input
            type="number"
            placeholder={t('cash.amountPlaceholder')}
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
      </div>

      <Button className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
        <Camera className="w-5 h-5" />
        {t('discount.takePhoto')}
      </Button>
    </div>
  );
};

export default DiscountTab;
