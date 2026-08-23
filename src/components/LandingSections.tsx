import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  BadgePercent,
  Banknote,
  HeartHandshake,
  KeyRound,
  Link2,
  QrCode,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
  WalletCards,
} from 'lucide-react';
import { changeLanguage } from '@/i18n';
import fountainGarden from '@/assets/abundance-fountain.webp';
import abundanceHero from '@/assets/abundance-garden-hero.webp';
import mandalaGreen from '@/assets/mandala-green-alpha.webp';

const REGISTER_URL = 'https://shop.lanapays.us/welcome';

export default function LandingSections() {
  const { t, i18n } = useTranslation();
  const worldRef = useRef<HTMLDivElement>(null);
  const lang = i18n.language?.startsWith('sl') ? 'sl' : 'en';
  const registerHref = `${REGISTER_URL}?lang=${lang}`;
  const copy = lang === 'sl'
    ? {
        natureTitle: 'Obilje je tok, ne obljuba.',
        natureBody: 'Vaše delo, resnična izmenjava in tehnologija, ki ostane v ozadju. Lana Pays poveže vse troje na telefonu, ki ga že imate.',
        whole: 'Cel račun ostane vaš',
        wholeBody: 'Nagrada se prišteje. Nikoli se ne odšteje od vaše prodaje.',
        both: 'Dve poti plačila',
        bothBody: 'Gotovina ali kartica v vaši valuti ter neposredno plačilo z Lanami.',
        key: 'Ključ ostane pri vas',
        keyBody: 'Podpis se zgodi v brskalniku. Vaš zasebni ključ se ne pošlje strežniku.',
        trust: 'Zaupanje raste',
        trustBody: 'Resnični nakupi, poštene cene in odnos, ki vedno začne s pogovorom.',
        storyEyebrow: 'Za ponudnike, ki dajejo več',
        storyCta: 'Odkrijte možnosti',
        servicesEyebrow: 'Možnosti na telefonu',
        servicesTitle: 'Vse, kar potrebujete za izmenjavo.',
        servicesBody: 'Od računa za pultom do povezave na daljavo — ista mirna, varna vstopna točka.',
        remoteTitle: 'Plačilo na daljavo',
        remoteBody: 'Ustvarite povezavo za plačilo in jo pošljite kupcu, ne glede na to, kje je.',
        regularTitle: 'Redne stranke',
        regularBody: 'Poiščite stranko, skenirajte njeno kodo ali jo registrirajte neposredno pri pultu.',
        rewardEyebrow: 'Nagrada, ki se prišteje',
        rewardTitle: 'Vaša cena ostane cela.',
        howEyebrow: 'Naraven potek',
        howTitle: 'Štirje koraki. Brez nove naprave.',
        trustEyebrow: 'Vaš mir je del sistema',
        trustTitle: 'Varnost in zaupanje sta vgrajena.',
        invitation: 'Pripravljeni na naslednjo izmenjavo?',
        invitationBody: 'Prijavite svojo ponudbo in postanite del ekonomije, kjer kakovost, odgovornost in obilje krožijo skupaj.',
        register: 'Predstavite svojo ponudbo',
        quote: 'Ko vrednost kroži pošteno, obilje postane naravno stanje.',
        footerLine: 'Vaše delo. Vaša vrednost. Vaš tok.',
      }
    : {
        natureTitle: 'Abundance is a flow, not a promise.',
        natureBody: 'Your work, a real exchange, and technology that stays in the background. Lana Pays connects all three on the phone you already have.',
        whole: 'Your whole invoice stays yours',
        wholeBody: 'The reward is added on top. It is never deducted from your sale.',
        both: 'Two payment paths',
        bothBody: 'Cash or card in your currency, plus direct payment with LANA.',
        key: 'Your key stays with you',
        keyBody: 'Signing happens in the browser. Your private key is never sent to a server.',
        trust: 'Trust grows',
        trustBody: 'Real purchases, honest prices, and a relationship that always begins with conversation.',
        storyEyebrow: 'For providers who give more',
        storyCta: 'Discover the options',
        servicesEyebrow: 'Options on your phone',
        servicesTitle: 'Everything you need for an exchange.',
        servicesBody: 'From a counter invoice to a remote link — the same calm, secure entry point.',
        remoteTitle: 'Remote payment',
        remoteBody: 'Create a payment link and send it to your customer, wherever they are.',
        regularTitle: 'Regular customers',
        regularBody: 'Find a customer, scan their code, or register them directly at the counter.',
        rewardEyebrow: 'A reward added on top',
        rewardTitle: 'Your price stays whole.',
        howEyebrow: 'A natural flow',
        howTitle: 'Four steps. No new device.',
        trustEyebrow: 'Your peace of mind is part of the system',
        trustTitle: 'Security and trust are built in.',
        invitation: 'Ready for the next exchange?',
        invitationBody: 'Present your offer and join an economy where quality, responsibility, and abundance move together.',
        register: 'Present your offer',
        quote: 'When value circulates honestly, abundance becomes a natural state.',
        footerLine: 'Your work. Your value. Your flow.',
      };

  useEffect(() => {
    const root = worldRef.current?.closest('.pays-landing') as HTMLElement | null;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    root.classList.add('pl-armed');
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('pl-in');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px 10% 0px', threshold: 0.08 });
    root.querySelectorAll('.pl-reveal').forEach(element => observer.observe(element));
    requestAnimationFrame(() => {
      root.querySelectorAll('.pl-reveal').forEach(element => {
        if (element.getBoundingClientRect().top < window.innerHeight) element.classList.add('pl-in');
      });
    });
    return () => observer.disconnect();
  }, []);

  const values = [
    { Icon: Banknote, title: copy.whole, body: copy.wholeBody },
    { Icon: WalletCards, title: copy.both, body: copy.bothBody },
    { Icon: ShieldCheck, title: copy.key, body: copy.keyBody },
    { Icon: HeartHandshake, title: copy.trust, body: copy.trustBody },
  ];

  const services = [
    { Icon: Banknote, title: t('landing.cur1Title'), body: t('landing.cur1Body'), image: abundanceHero, motion: 'wind', position: '62% 60%' },
    { Icon: Sparkles, title: t('landing.cur2Title'), body: t('landing.cur2Body'), image: fountainGarden, motion: 'water', position: '16% 56%' },
    { Icon: Link2, title: copy.remoteTitle, body: copy.remoteBody, image: abundanceHero, motion: 'rain', position: '88% 40%' },
    { Icon: Users, title: copy.regularTitle, body: copy.regularBody, image: fountainGarden, motion: 'light', position: '56% 45%' },
  ];

  const steps = [
    { Icon: KeyRound, title: t('landing.how1Title'), body: t('landing.how1Body') },
    { Icon: WalletCards, title: t('landing.how2Title'), body: t('landing.how2Body') },
    { Icon: ScanLine, title: t('landing.how3Title'), body: t('landing.how3Body') },
    { Icon: QrCode, title: t('landing.how4Title'), body: t('landing.how4Body') },
  ];

  return (
    <div className="pl-world" ref={worldRef}>
      <section className="pl-values" id="obilje" aria-labelledby="pl-values-title">
        <img className="pl-corner-mandala pl-corner-left" src={mandalaGreen} alt="" aria-hidden="true" />
        <img className="pl-corner-mandala pl-corner-right" src={mandalaGreen} alt="" aria-hidden="true" />
        <div className="pl-section-title pl-reveal">
          <span>{t('landing.abundanceEyebrow')}</span>
          <h2 id="pl-values-title">{copy.natureTitle}</h2>
          <p>{copy.natureBody}</p>
        </div>
        <div className="pl-value-grid">
          {values.map(({ Icon, title, body }, index) => (
            <article className="pl-value pl-reveal" key={title} style={{ transitionDelay: `${index * 70}ms` }}>
              <div className="pl-value-icon"><Icon /></div>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="pl-story" aria-labelledby="pl-story-title">
        <div className="pl-fountain-visual" aria-hidden="true">
          <img src={fountainGarden} alt="" />
          <div className="pl-fountain-sun" />
          <div className="pl-water-streams"><span /><span /><span /><span /></div>
          <div className="pl-water-drops">{Array.from({ length: 10 }, (_, index) => <i key={index} />)}</div>
          <div className="pl-water-ripples"><i /><i /><i /></div>
        </div>
        <div className="pl-story-copy pl-reveal">
          <span className="pl-eyebrow">{copy.storyEyebrow}</span>
          <h2 id="pl-story-title">{t('landing.abundanceTitle')}</h2>
          <p>{t('landing.recognitionBody')}</p>
          <p>{t('landing.abundanceBody')}</p>
          <blockquote>{t('landing.abundanceQuote')}</blockquote>
          <a className="pl-text-cta" href="#moznosti">{copy.storyCta} <ArrowRight /></a>
        </div>
      </section>

      <section className="pl-services" id="moznosti" aria-labelledby="pl-services-title">
        <div className="pl-section-title pl-reveal">
          <span>{copy.servicesEyebrow}</span>
          <h2 id="pl-services-title">{copy.servicesTitle}</h2>
          <p>{copy.servicesBody}</p>
        </div>
        <div className="pl-service-grid">
          {services.map(({ Icon, title, body, image, motion, position }, index) => (
            <article className="pl-service-card pl-reveal" data-motion={motion} key={title} style={{ transitionDelay: `${index * 80}ms` }}>
              <div className="pl-service-image">
                <img src={image} alt="" style={{ objectPosition: position }} />
                <span className="pl-service-weather" aria-hidden="true" />
              </div>
              <div className="pl-service-copy">
                <Icon />
                <h3>{title}</h3>
                <p>{body}</p>
                <span className="pl-service-link">{lang === 'sl' ? 'Izvedite več' : 'Learn more'} <ArrowRight /></span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="pl-reward" aria-labelledby="pl-reward-title">
        <div className="pl-reward-orbit" aria-hidden="true">
          <img src={mandalaGreen} alt="" />
          <strong>20%</strong>
        </div>
        <div className="pl-reward-copy pl-reveal">
          <span className="pl-eyebrow">{copy.rewardEyebrow}</span>
          <h2 id="pl-reward-title">{copy.rewardTitle}</h2>
          <p>{t('landing.twentyBody')}</p>
          <div className="pl-reward-points">
            <div><BadgePercent /><span><strong>{t('landing.twenty1Title')}</strong>{t('landing.twenty1Body')}</span></div>
            <div><Users /><span><strong>{t('landing.twenty2Title')}</strong>{t('landing.twenty2Body')}</span></div>
          </div>
        </div>
      </section>

      <section className="pl-how" id="kako" aria-labelledby="pl-how-title">
        <div className="pl-section-title pl-reveal">
          <span>{copy.howEyebrow}</span>
          <h2 id="pl-how-title">{copy.howTitle}</h2>
          <p>{t('landing.howBody')}</p>
        </div>
        <div className="pl-step-grid">
          {steps.map(({ Icon, title, body }, index) => (
            <article className="pl-step pl-reveal" key={title} style={{ transitionDelay: `${index * 70}ms` }}>
              <span className="pl-step-number">0{index + 1}</span>
              <div className="pl-step-icon"><Icon /></div>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="pl-trust" id="zaupanje" aria-labelledby="pl-trust-title">
        <div className="pl-trust-mandala" aria-hidden="true"><img src={mandalaGreen} alt="" /></div>
        <div className="pl-trust-content">
          <div className="pl-section-title pl-reveal">
            <span>{copy.trustEyebrow}</span>
            <h2 id="pl-trust-title">{copy.trustTitle}</h2>
          </div>
          <div className="pl-trust-grid">
            <article className="pl-trust-card pl-reveal">
              <ShieldCheck />
              <h3>{t('landing.keyTitle')}</h3>
              <p>{t('landing.keyBody')}</p>
            </article>
            <article className="pl-trust-card pl-reveal">
              <HeartHandshake />
              <h3>{t('landing.trustTitle')}</h3>
              <p>{t('landing.trustBody')}</p>
            </article>
          </div>
        </div>
      </section>

      <section className="pl-invitation">
        <div className="pl-invitation-scene" style={{ backgroundImage: `url(${abundanceHero})` }} aria-hidden="true" />
        <blockquote className="pl-reveal">“{copy.quote}”</blockquote>
        <div className="pl-invitation-card pl-reveal">
          <span>{t('landing.joinEyebrow')}</span>
          <h2>{copy.invitation}</h2>
          <p>{copy.invitationBody}</p>
          <a href={registerHref} target="_blank" rel="noopener noreferrer">{copy.register} <ArrowRight /></a>
        </div>
      </section>

      <footer className="pl-footer">
        <a className="pl-footer-brand" href="#domov">
          <img src={mandalaGreen} alt="" />
          <span><strong>Lana Pays.Us</strong><small>{copy.footerLine}</small></span>
        </a>
        <div className="pl-footer-links">
          <a href="#obilje">{copy.navAbundance}</a>
          <a href="#moznosti">{copy.navServices}</a>
          <a href="#kako">{copy.navHow}</a>
          <a href="#zaupanje">{copy.navTrust}</a>
          <a href="https://shop.lanapays.us" target="_blank" rel="noopener noreferrer"><Store /> shop.lanapays.us</a>
        </div>
        <div className="pl-footer-side">
          <p>{t('landing.footerAlready')}<br />{t('landing.footerNote')}</p>
          <div className="pl-lang" role="group" aria-label={t('landing.langLabel')}>
            <button type="button" className={lang === 'sl' ? 'is-active' : ''} onClick={() => changeLanguage('sl')}>SL</button>
            <button type="button" className={lang === 'en' ? 'is-active' : ''} onClick={() => changeLanguage('en')}>EN</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
