/**
 * KIND 4 (NIP-04) chat dialog. Adapted from shop.lanapays.us with:
 *  - mobile session field `privateKeyHex` (not nostrPrivateKey)
 *  - shadcn theme tokens for dark/light mode parity
 *  - i18n strings
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { nip04Encrypt, nip04Decrypt } from '@/lib/nip04';
import { signNostrEvent } from '@/lib/nostrSigning';
import { X, Send, Loader2, MessageCircle, ShieldCheck } from 'lucide-react';

interface Message {
  id: string;
  content: string;
  fromMe: boolean;
  timestamp: number;
}

interface CaretakerChatProps {
  recipientHex: string;
  recipientName: string;
  recipientPicture?: string | null;
  onClose: () => void;
}

export function CaretakerChat({ recipientHex, recipientName, recipientPicture, onClose }: CaretakerChatProps) {
  const { t } = useTranslation();
  const { session } = useAuth();
  const [messages, setMessages]       = useState<Message[]>([]);
  const [newMessage, setNewMessage]   = useState('');
  const [isLoading, setIsLoading]     = useState(true);
  const [isSending, setIsSending]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const messagesEndRef                = useRef<HTMLDivElement>(null);
  const pollRef                       = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestTimestampRef            = useRef(0);

  const decryptEvents = useCallback(async (events: any[]): Promise<Message[]> => {
    if (!session) return [];
    const decrypted: Message[] = [];
    for (const event of events) {
      try {
        const fromMe = event.pubkey === session.nostrHexId;
        const otherPubkey = fromMe
          ? (event.tags.find((tag: string[]) => tag[0] === 'p')?.[1] || '')
          : event.pubkey;
        // Only keep messages between us and the recipient
        if (otherPubkey !== recipientHex && event.pubkey !== recipientHex) continue;

        const plaintext = await nip04Decrypt(
          event.content,
          session.privateKeyHex,
          fromMe ? recipientHex : event.pubkey
        );
        decrypted.push({ id: event.id, content: plaintext, fromMe, timestamp: event.created_at });
      } catch {
        // Skip messages that can't be decrypted (corrupt / wrong cipher / unrelated)
      }
    }
    return decrypted.sort((a, b) => a.timestamp - b.timestamp);
  }, [session, recipientHex]);

  const fetchMessages = useCallback(async (since?: number) => {
    if (!session) return;
    try {
      const res = await fetch('/api/dm/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPubkey: session.nostrHexId, since }),
      });
      const data = await res.json();
      if (!data.success) return;

      const newDecrypted = await decryptEvents(data.events || []);
      if (newDecrypted.length === 0) return;

      const maxTs = Math.max(...newDecrypted.map(m => m.timestamp));
      if (maxTs > latestTimestampRef.current) latestTimestampRef.current = maxTs;

      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id));
        const trulyNew = newDecrypted.filter(m => !existingIds.has(m.id));
        if (trulyNew.length === 0) return prev;
        return [...prev, ...trulyNew].sort((a, b) => a.timestamp - b.timestamp);
      });
    } catch {
      if (!since) setError(t('caretaker.chat.loadFailed'));
    }
  }, [session, decryptEvents, t]);

  // Initial load — server default is 30 days; we explicitly ask further
  // back so old caretaker threads show up immediately on first open.
  useEffect(() => {
    setIsLoading(true);
    const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
    // Seed the polling cursor so the interval starts firing even when the
    // initial load returns zero messages (previously the poll was gated on
    // latestTimestampRef > 0 and would never fire for a brand-new thread).
    latestTimestampRef.current = ninetyDaysAgo;
    fetchMessages(ninetyDaysAgo).finally(() => setIsLoading(false));
  }, [fetchMessages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Poll every 10 s for new messages — since cursor is always set
  useEffect(() => {
    pollRef.current = setInterval(() => {
      if (latestTimestampRef.current > 0) fetchMessages(latestTimestampRef.current - 5);
    }, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchMessages]);

  const handleSend = async () => {
    if (!session || !newMessage.trim()) return;
    setIsSending(true);
    setError(null);
    try {
      const encrypted = await nip04Encrypt(newMessage.trim(), session.privateKeyHex, recipientHex);
      const signedEvent = signNostrEvent(session.privateKeyHex, 4, encrypted, [['p', recipientHex]]);

      // Optimistic update — show the message before relays ack
      const optimisticMsg: Message = {
        id: signedEvent.id,
        content: newMessage.trim(),
        fromMe: true,
        timestamp: signedEvent.created_at,
      };
      setMessages(prev => [...prev, optimisticMsg]);
      setNewMessage('');

      const res = await fetch('/api/dm/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: signedEvent }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(t('caretaker.chat.sendFailed'));
      } else {
        latestTimestampRef.current = signedEvent.created_at;
      }
    } catch {
      setError(t('caretaker.chat.sendFailed'));
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm z-[80]" onClick={onClose} />
      <div className="fixed inset-4 sm:inset-x-1/2 sm:-translate-x-1/2 sm:w-full sm:max-w-lg sm:h-[80vh] sm:top-12 sm:bottom-12 z-[90] bg-card rounded-2xl border border-border shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {recipientPicture ? (
              <img src={recipientPicture} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <MessageCircle className="w-4 h-4 text-primary" />
              </div>
            )}
            <div className="min-w-0">
              <p className="font-semibold text-foreground truncate">{recipientName}</p>
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" /> {t('caretaker.chat.encryptedNote')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-background/40">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : error && messages.length === 0 ? (
            <div className="text-center py-12 text-destructive text-sm">{error}</div>
          ) : messages.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">{t('caretaker.chat.empty')}</div>
          ) : (
            messages.map(msg => (
              <div key={msg.id} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm ${
                  msg.fromMe
                    ? 'bg-primary text-primary-foreground rounded-br-md'
                    : 'bg-secondary text-foreground rounded-bl-md'
                }`}>
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  <p className={`text-[10px] mt-1 ${msg.fromMe ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                    {new Date(msg.timestamp * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <div className="px-4 py-3 border-t border-border bg-card shrink-0">
          {error && messages.length > 0 && (
            <p className="text-[11px] text-destructive mb-2">{error}</p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={newMessage}
              onChange={e => setNewMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('caretaker.chat.placeholder')}
              rows={1}
              className="flex-1 resize-none px-3 py-2 text-sm border border-border rounded-xl bg-background text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              style={{ maxHeight: '120px' }}
            />
            <button
              onClick={handleSend}
              disabled={isSending || !newMessage.trim()}
              className="w-10 h-10 flex items-center justify-center bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
