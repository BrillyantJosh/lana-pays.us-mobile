/**
 * The optional "Note" field on a new Lana-online payment request (what it is
 * for / who it is for). Says plainly that the customer sees it too — the pay
 * page shows it — so nobody writes something there meant only for themselves.
 */
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { REQUEST_NOTE_MAX, typedNote, noteLength } from '@/lib/requestNote';

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export function RequestNoteField({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor="request-note" className="text-sm font-medium text-foreground">
        {t('lanaOnline.noteLabel')}{' '}
        <span className="text-muted-foreground font-normal">({t('lanaOnline.noteOptional')})</span>
      </Label>
      <Textarea
        id="request-note"
        rows={2}
        value={value}
        placeholder={t('lanaOnline.notePlaceholder')}
        onChange={(e) => onChange(typedNote(e.target.value))}
        className="min-h-0 rounded-xl bg-background border-input resize-none"
      />
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('lanaOnline.noteHint')}</span>
        <span className="shrink-0 tabular-nums" data-testid="note-count">{noteLength(value)}/{REQUEST_NOTE_MAX}</span>
      </div>
    </div>
  );
}
