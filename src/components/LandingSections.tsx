import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage } from '@/i18n';

/**
 * The landing content below the hero on /login.
 *
 * Atmosphere (fixed mandala, grain, vignette) lives at the page root in
 * Login.tsx, feed-style; this component is only the story: sections, cards,
 * and the closing green door. Everything scoped under `.pays-landing`
 * (src/landing.css); headings carry halos so they stay readable over the
 * faded mandala.
 */

const REGISTER_URL = 'https://shop.lanapays.us/welcome';

function LotusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M32 10c4 6 6 12 6 18s-2 12-6 16c-4-4-6-10-6-16s2-12 6-18z" fill="currentColor" opacity="0.55" />
      <path d="M14 22c7 1 12 4 15 9 3 5 4 10 3 15-7-1-12-4-15-9-3-5-4-10-3-15z" fill="currentColor" opacity="0.35" />
      <path d="M50 22c-7 1-12 4-15 9-3 5-4 10-3 15 7-1 12-4 15-9 3-5 4-10 3-15z" fill="currentColor" opacity="0.35" />
      <path d="M6 36c6-2 12-2 17 0 5 2 8 6 9 10-6 2-12 2-17 0-5-2-8-6-9-10z" fill="currentColor" opacity="0.22" />
      <path d="M58 36c-6-2-12-2-17 0-5 2-8 6-9 10 6 2 12 2 17 0 5-2 8-6 9-10z" fill="currentColor" opacity="0.22" />
    </svg>
  );
}

/** A section heading block: eyebrow → h2 → lead. */
function SectionHead({ id, eyebrow, title, body }: { id: string; eyebrow: string; title: string; body: string }) {
  return (
    <>
      <div className="pl-eyebrow">{eyebrow}</div>
      <h2 id={id}>{title}</h2>
      <p className="pl-lead">{body}</p>
    </>
  );
}

/** Cards used for step lists and explanation grids. `num` is optional. */
function Cards({ items }: { items: { num?: string; title: string; body: string; rail?: 'eur' | 'lana' }[] }) {
  return (
    <div className="pl-cards">
      {items.map(it => (
        <div className="pl-card pl-reveal" key={it.title}>
          <div className={it.rail ? `pl-rail${it.rail === 'lana' ? ' pl-rail-lana' : ''}` : undefined}>
            {it.num && <span className="pl-num">{it.num}</span>}
            <h3>{it.title}</h3>
            <p>{it.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function LandingSections() {
  const { t, i18n } = useTranslation();
  const worldRef = useRef<HTMLDivElement>(null);

  // Reveal-on-scroll. The hidden state lives behind `.pl-armed`, which only
  // exists once this effect has run — so if JS never executes the page is
  // fully readable rather than a column of invisible text.
  useEffect(() => {
    const root = worldRef.current?.closest('.pays-landing') as HTMLElement | null;
    if (!root) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') return;

    root.classList.add('pl-armed');

    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('pl-in');
            io.unobserve(e.target);
          }
        }
      },
      // Positive bottom margin: start the fade slightly BEFORE the element
      // scrolls in, so a reader moving at normal speed meets text that is
      // already there rather than a blank gap that fills in behind them.
      { rootMargin: '0px 0px 14% 0px', threshold: 0.01 }
    );

    root.querySelectorAll('.pl-reveal').forEach(el => io.observe(el));

    // Anything already on screen at mount should not animate in at all.
    requestAnimationFrame(() => {
      root.querySelectorAll('.pl-reveal').forEach(el => {
        if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('pl-in');
      });
    });

    return () => io.disconnect();
  }, []);

  const lang = i18n.language?.startsWith('sl') ? 'sl' : 'en';
  const registerHref = `${REGISTER_URL}?lang=${lang}`;

  return (
    <>
      <div className="pl-world" ref={worldRef}>
        <div className="pl-world-content">

          {/* ── Recognition ─────────────────────────────────────────────── */}
          <section className="pl-section pl-reveal" aria-labelledby="pl-h-recognition">
            <SectionHead
              id="pl-h-recognition"
              eyebrow={t('landing.recognitionEyebrow')}
              title={t('landing.recognitionTitle')}
              body={t('landing.recognitionBody')}
            />
          </section>

          {/* ── Abundance ───────────────────────────────────────────────── */}
          <section className="pl-section pl-reveal" aria-labelledby="pl-h-abundance">
            <SectionHead
              id="pl-h-abundance"
              eyebrow={t('landing.abundanceEyebrow')}
              title={t('landing.abundanceTitle')}
              body={t('landing.abundanceBody')}
            />
            <p className="pl-quote">{t('landing.abundanceQuote')}</p>
          </section>

          {/* ── The 20% ─────────────────────────────────────────────────── */}
          <section className="pl-section" aria-labelledby="pl-h-twenty">
            <div className="pl-reveal">
              <div className="pl-eyebrow">{t('landing.twentyEyebrow')}</div>
              <div className="pl-figure" aria-hidden="true">20%</div>
              <div className="pl-figure-note">{t('landing.twentyFigureNote')}</div>
              <h2 id="pl-h-twenty">{t('landing.twentyTitle')}</h2>
              <p className="pl-lead">{t('landing.twentyBody')}</p>
            </div>
            <Cards
              items={[
                { title: t('landing.twenty1Title'), body: t('landing.twenty1Body') },
                { title: t('landing.twenty2Title'), body: t('landing.twenty2Body') },
                { title: t('landing.twenty3Title'), body: t('landing.twenty3Body') },
                { title: t('landing.twenty4Title'), body: t('landing.twenty4Body') },
              ]}
            />
          </section>

          {/* ── Something more ──────────────────────────────────────────── */}
          <section className="pl-section" aria-labelledby="pl-h-more">
            <div className="pl-reveal">
              <SectionHead
                id="pl-h-more"
                eyebrow={t('landing.moreEyebrow')}
                title={t('landing.moreTitle')}
                body={t('landing.moreBody')}
              />
            </div>
            <Cards
              items={[
                { title: t('landing.more1Title'), body: t('landing.more1Body') },
                { title: t('landing.more2Title'), body: t('landing.more2Body') },
                { title: t('landing.more3Title'), body: t('landing.more3Body') },
                { title: t('landing.more4Title'), body: t('landing.more4Body') },
              ]}
            />
          </section>

          {/* ── How it works at the counter ─────────────────────────────── */}
          <section className="pl-section" aria-labelledby="pl-h-how">
            <div className="pl-reveal">
              <SectionHead
                id="pl-h-how"
                eyebrow={t('landing.howEyebrow')}
                title={t('landing.howTitle')}
                body={t('landing.howBody')}
              />
            </div>
            <Cards
              items={[
                { num: '01', title: t('landing.how1Title'), body: t('landing.how1Body') },
                { num: '02', title: t('landing.how2Title'), body: t('landing.how2Body') },
                { num: '03', title: t('landing.how3Title'), body: t('landing.how3Body') },
                { num: '04', title: t('landing.how4Title'), body: t('landing.how4Body') },
              ]}
            />
          </section>

          {/* ── Euros and LANA ──────────────────────────────────────────── */}
          <section className="pl-section" aria-labelledby="pl-h-currencies">
            <div className="pl-reveal">
              <SectionHead
                id="pl-h-currencies"
                eyebrow={t('landing.currenciesEyebrow')}
                title={t('landing.currenciesTitle')}
                body={t('landing.currenciesBody')}
              />
            </div>
            <Cards
              items={[
                { title: t('landing.cur1Title'), body: t('landing.cur1Body'), rail: 'eur' },
                { title: t('landing.cur2Title'), body: t('landing.cur2Body'), rail: 'lana' },
                { title: t('landing.cur3Title'), body: t('landing.cur3Body') },
              ]}
            />
          </section>

          {/* ── The key ─────────────────────────────────────────────────── */}
          <section className="pl-section" aria-labelledby="pl-h-key">
            <div className="pl-eyebrow">{t('landing.keyEyebrow')}</div>
            <div className="pl-key-card pl-reveal">
              <LotusIcon className="pl-lotus" />
              <div>
                <h3 id="pl-h-key">{t('landing.keyTitle')}</h3>
                <p style={{ fontSize: '14.5px', lineHeight: 1.7, color: 'var(--pl-ink-soft)', margin: 0 }}>
                  {t('landing.keyBody')}
                </p>
              </div>
            </div>
          </section>

          {/* ── Trust ───────────────────────────────────────────────────── */}
          <section className="pl-section" aria-labelledby="pl-h-trust">
            <div className="pl-eyebrow">{t('landing.trustEyebrow')}</div>
            <div className="pl-key-card pl-trust-card pl-reveal">
              <LotusIcon className="pl-lotus" />
              <div>
                <h3 id="pl-h-trust">{t('landing.trustTitle')}</h3>
                <p style={{ fontSize: '14.5px', lineHeight: 1.7, color: 'var(--pl-ink-soft)', margin: 0 }}>
                  {t('landing.trustBody')}
                </p>
              </div>
            </div>
          </section>

          {/* ── The invitation ──────────────────────────────────────────── */}
          <section className="pl-section" aria-labelledby="pl-h-join">
            <div className="pl-reveal">
              <SectionHead
                id="pl-h-join"
                eyebrow={t('landing.joinEyebrow')}
                title={t('landing.joinTitle')}
                body={t('landing.joinBody')}
              />
            </div>
            <Cards
              items={[
                { num: '01', title: t('landing.join1Title'), body: t('landing.join1Body') },
                { num: '02', title: t('landing.join2Title'), body: t('landing.join2Body') },
                { num: '03', title: t('landing.join3Title'), body: t('landing.join3Body') },
              ]}
            />
          </section>

          {/* ── Footer: the violet door, rhyming with the green one above ── */}
          <footer className="pl-footer">
            <a
              className="pl-circle-cta pl-reveal"
              href={registerHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="pl-circle-label">
                {t('landing.ctaCircleLabel').split('\n').map((line, i) => (
                  <span key={i} style={{ display: 'block' }}>{line}</span>
                ))}
              </span>
              <span className="pl-circle-sub">{t('landing.ctaCircleSub')}</span>
            </a>

            <div className="pl-footer-links">
              {t('landing.footerAlready')}
              <br />
              <a href="https://shop.lanapays.us" target="_blank" rel="noopener noreferrer">shop.lanapays.us</a>
              {' · '}
              {t('landing.footerNote')}
            </div>

            {/* Language toggle lives at the bottom: a returning merchant never
                needs it (their language comes from their KIND 0 profile on
                login), so it must not compete with the sign-in circle up top. */}
            <div className="pl-lang" role="group" aria-label={t('landing.langLabel')} style={{ marginTop: 28 }}>
              <button
                type="button"
                className={lang === 'sl' ? 'is-active' : ''}
                onClick={() => changeLanguage('sl')}
              >
                SL
              </button>
              <button
                type="button"
                className={lang === 'en' ? 'is-active' : ''}
                onClick={() => changeLanguage('en')}
              >
                EN
              </button>
            </div>
          </footer>

        </div>
      </div>
    </>
  );
}
