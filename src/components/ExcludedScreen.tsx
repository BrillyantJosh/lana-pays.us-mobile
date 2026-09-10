/**
 * Shown INSTEAD of the application when a commission gross-violation decision
 * stands (Nostr KIND 87058).
 *
 * Deliberately a dead end: no navigation, nothing of the person's own content,
 * and no way past it. The point of the sanction is that the account is not
 * reachable, so this screen must not be a doorway with a nicer sign on it.
 *
 * Two things it does say, because a closed door without them is just cruelty:
 * what the commission gave as the ground, and the two places that stay open —
 * lana.discount, so nobody is ever locked away from selling what they hold, and
 * mejmosefajn.org, where a request to re-enter is signed.
 *
 * It carries its own words rather than reading the host app's translations, so
 * the same sanction reads identically across the fleet — including in the six
 * applications that have no translation system at all.
 */

export type ExcludedLang = 'en' | 'sl';

export interface ExcludedVerdict {
  /** The commission's own words. Empty or absent when the report would not load. */
  ground?: string;
  /** Unix seconds the decision took effect. */
  since?: number;
  /** The SPLIT round it runs to, or null/undefined when it has no end. */
  untilSplit?: number | null;
}

const COPY = {
  en: {
    title: 'Your access is paused',
    lead: 'A commission of facilitators has recorded a gross violation, and while it stands this application is not available to you.',
    reasonLabel: 'The stated ground',
    noReason: 'The reason could not be loaded right now. It is published with the decision and can be read again later.',
    sinceLabel: 'In effect since',
    indefinite: 'This decision has no end date.',
    until: 'This decision runs until SPLIT {n}.',
    openTitle: 'What stays open',
    openSell: 'lana.discount stays open. Nothing here touches what you hold or your ability to sell it.',
    openReturn: 'mejmosefajn.org stays open for the request to re-enter, which you sign with your own key.',
    returnTitle: 'How can you come back?',
    returnIntro: 'Before asking to re-enter the community, we invite you to pause and answer four questions honestly for yourself:',
    q1: 'Why do I want to be here? What is my intention, and what do I want to co-create through my presence in the community?',
    q2: 'What am I creating through my behaviour? What effect do my actions, the way I communicate and my attitude towards others have on the people around me and on the community as a whole?',
    q3: 'Is what I am creating consistent with the reason I want to be here, and with the principles of the community?',
    q4: 'If it is not, am I willing to change my behaviour?',
    principlesA: 'Lana8Wonder is a community founded on personal responsibility, freedom, respect, cooperation and conscious co-creation. Members take responsibility for their conduct, respect the freedom and boundaries of others, and act in ways consistent with the community’s principles even in situations of conflict.',
    principlesB: 'We start from a simple principle:',
    motto: 'Everyone is welcome. Not every behaviour is compatible with Lana8Wonder.',
    principlesC: 'So in Lana we do not expect perfection. We do expect a willingness to look at one’s own behaviour, to recognise what it creates, and to change it when it is not consistent with our intention and the principles of the community.',
    principlesD: 'Inner change is always voluntary. Participation in the community, however, is conditional on respecting its principles.',
    principlesE: 'If, after honest introspection, you feel that you want to be part of such a community and are ready to bring your conduct into line with these principles, you may ask to re-enter. A process of reintegration can then begin, and the next steps for restoring your participation in the community will be agreed.',
    apply: 'Ask to re-enter on mejmosefajn.org',
    sell: 'Go to lana.discount',
    back: 'Back to sign in',
  },
  sl: {
    title: 'Tvoj dostop je zaustavljen',
    lead: 'Komisija fasilitatorjev je zabeležila grobo kršitev. Dokler ta velja, ta aplikacija zate ni dostopna.',
    reasonLabel: 'Navedeni razlog',
    noReason: 'Razloga trenutno ni bilo mogoče naložiti. Objavljen je skupaj z odločitvijo in ga je mogoče prebrati pozneje.',
    sinceLabel: 'Velja od',
    indefinite: 'Ta odločitev nima roka.',
    until: 'Ta odločitev velja do SPLITA {n}.',
    openTitle: 'Kaj ostaja odprto',
    openSell: 'lana.discount ostaja odprt. Nič od tega se ne dotakne tega, kar imaš, ne tvoje možnosti, da to prodaš.',
    openReturn: 'mejmosefajn.org ostaja odprt za prošnjo za ponovni vstop, ki jo podpišeš s svojim ključem.',
    returnTitle: 'Kako lahko ponovno vstopiš?',
    returnIntro: 'Preden zaprosiš za ponovni vstop v skupnost, te vabimo, da se ustaviš in si iskreno odgovoriš na štiri temeljna vprašanja:',
    q1: 'Zakaj želim biti tukaj? Kaj je moj namen in kaj želim s svojo prisotnostjo v skupnosti soustvarjati?',
    q2: 'Kaj s svojim vedenjem ustvarjam? Kakšen vpliv imajo moja dejanja, način komunikacije in odnos do drugih na ljudi okoli mene in na skupnost kot celoto?',
    q3: 'Ali je to, kar ustvarjam, skladno z razlogom, zaradi katerega želim biti tukaj, ter z načeli skupnosti?',
    q4: 'Če ni, ali sem pripravljen svoje vedenje spremeniti?',
    principlesA: 'Lana8Wonder je skupnost, ki temelji na osebni odgovornosti, svobodi, spoštovanju, sodelovanju in zavestnem soustvarjanju. Člani prevzemajo odgovornost za svoje ravnanje, spoštujejo svobodo in meje drugih ter tudi v konfliktnih situacijah ravnajo na način, ki je skladen z načeli skupnosti.',
    principlesB: 'Pri tem izhajamo iz preprostega načela:',
    motto: 'Vsakdo je dobrodošel. Ni pa vsako vedenje združljivo z Lano8Wonder.',
    principlesC: 'Zato v Lani ne pričakujemo popolnosti. Pričakujemo pa pripravljenost pogledati lastno vedenje, prepoznati, kaj z njim ustvarjamo, in ga spremeniti, kadar ni skladno z našim namenom in načeli skupnosti.',
    principlesD: 'Notranja sprememba je vedno prostovoljna. Sodelovanje v skupnosti pa je pogojeno s spoštovanjem njenih načel.',
    principlesE: 'Če po iskreni introspekciji začutiš, da želiš biti del takšne skupnosti in si pripravljen svoje ravnanje uskladiti s temi načeli, lahko zaprosiš za ponovni vstop. Takrat se lahko začne proces ponovne vključitve in določijo nadaljnji koraki za ponovno vzpostavitev sodelovanja v skupnosti.',
    apply: 'Zaprosi za ponovni vstop na mejmosefajn.org',
    sell: 'Na lana.discount',
    back: 'Nazaj na prijavo',
  },
} as const;

/**
 * The ground, without the standard re-entry text.
 *
 * Commissions paste the four questions and the community principles into the
 * report itself. This screen renders that block from its own words, so printing
 * it again would show the same thing twice — once in whatever language it was
 * written in, once in the reader's. Only the boilerplate is trimmed; the
 * commission's own account of what happened is never edited.
 */
export function specificGround(reason?: string): string | undefined {
  if (!reason) return reason;
  const marks = [/\n\s*Kako lahko ponovno vstopi[sš]\??/i, /\n\s*How can you come back\??/i];
  for (const m of marks) {
    const hit = reason.search(m);
    if (hit > 40) return reason.slice(0, hit).trim();
  }
  return reason;
}

export const ExcludedScreen = ({
  verdict,
  lang = 'en',
  onBack,
}: {
  verdict: ExcludedVerdict;
  lang?: ExcludedLang;
  /** Omit to leave the person with no way onward — correct when there is no sign-in to return to. */
  onBack?: () => void;
}) => {
  const t = COPY[lang] ?? COPY.en;
  const ground = specificGround(verdict.ground);
  const since =
    verdict.since && Number.isFinite(verdict.since)
      ? new Date(verdict.since * 1000).toLocaleDateString(lang === 'sl' ? 'sl-SI' : undefined, {
          year: 'numeric', month: 'long', day: 'numeric',
        })
      : null;

  return (
    <div className="min-h-screen bg-white px-4 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-500/15">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5 text-red-600 dark:text-red-400" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M5.6 5.6l12.8 12.8" />
            </svg>
          </span>
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">{t.title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">{t.lead}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-red-300 bg-red-50 p-5 dark:border-red-500/30 dark:bg-red-500/5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
            {t.reasonLabel}
          </p>
          {ground ? (
            <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{ground}</p>
          ) : (
            <p className="text-sm italic leading-relaxed text-slate-600 dark:text-slate-400">{t.noReason}</p>
          )}
          <div className="mt-3 space-y-1 border-t border-red-200 pt-3 text-xs text-slate-600 dark:border-red-500/20 dark:text-slate-400">
            {since && <p>{t.sinceLabel}: {since}</p>}
            <p>{verdict.untilSplit ? t.until.replace('{n}', String(verdict.untilSplit)) : t.indefinite}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-semibold">{t.openTitle}</h2>
          <ul className="mt-2 space-y-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            <li>{t.openSell}</li>
            <li>{t.openReturn}</li>
          </ul>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href="https://www.mejmosefajn.org"
              className="inline-flex items-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              {t.apply}
            </a>
            <a
              href="https://www.lana.discount"
              className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {t.sell}
            </a>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-semibold">{t.returnTitle}</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">{t.returnIntro}</p>

          <ol className="mt-4 space-y-3">
            {[t.q1, t.q2, t.q3, t.q4].map((q, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold dark:bg-slate-800">
                  {i + 1}
                </span>
                <span className="text-sm leading-relaxed">{q}</span>
              </li>
            ))}
          </ol>

          <div className="mt-5 space-y-3 border-t border-slate-200 pt-4 text-sm leading-relaxed text-slate-600 dark:border-slate-800 dark:text-slate-400">
            <p>{t.principlesA}</p>
            <p>{t.principlesB}</p>
            <p className="border-l-2 border-slate-400 pl-3 font-medium text-slate-900 dark:border-slate-500 dark:text-slate-100">
              {t.motto}
            </p>
            <p>{t.principlesC}</p>
            <p>{t.principlesD}</p>
            <p>{t.principlesE}</p>
          </div>
        </div>

        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 sm:w-auto dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {t.back}
          </button>
        )}
      </div>
    </div>
  );
};

export default ExcludedScreen;
