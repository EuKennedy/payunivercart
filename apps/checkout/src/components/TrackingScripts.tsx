'use client';

import Script from 'next/script';
import { useEffect, useRef } from 'react';

/**
 * Browser-side pixel injection. Pairs with the server-side CAPI
 * dispatch already in place — Meta dedupes by `event_id` when both
 * fire for the same conversion, which is the highest-confidence
 * attribution signal.
 *
 * Why client-side at all (CAPI alone seems enough):
 *   - ad-blockers eat ~30-60% of browser fires, but Meta still trusts
 *     them more than CAPI-only for the prospecting audiences.
 *   - debuggers (TagHound, Meta Pixel Helper) watch for `fbq` calls;
 *     producers expect to see the pixel "alive" in their browser when
 *     QA-ing a checkout.
 *
 * What gets injected per provider when present in `pixels`:
 *   - meta:       `fbq` init + PageView
 *   - ga4:        `gtag` config
 *   - tiktok:     `ttq` init + page view
 *   - pinterest:  `_pintrk` load + page_view
 *   - kwai:       `kwaiq` init + page view
 *
 * `eventId` (when supplied to `fireEvent`) is the same id the server-
 * side dispatcher used. This is the dedupe primitive for Meta CAPI
 * pairing; the other providers ignore it harmlessly.
 */

export interface PublicPixel {
  provider: 'meta' | 'ga4' | 'tiktok' | 'google_ads' | 'pinterest' | 'kwai';
  publicPixelId: string;
}

declare global {
  interface Window {
    fbq?: (
      action: string,
      eventName: string,
      params?: Record<string, unknown>,
      options?: { eventID?: string },
    ) => void;
    ttq?: { track: (eventName: string, params?: Record<string, unknown>) => void };
    _pintrk?: (action: string, eventName: string, params?: Record<string, unknown>) => void;
    kwaiq?: (action: string, eventName: string, params?: Record<string, unknown>) => void;
    gtag?: (...args: unknown[]) => void;
  }
}

export function TrackingScripts({ pixels }: { pixels: PublicPixel[] }) {
  if (pixels.length === 0) return null;
  return (
    <>
      {pixels.map((p) => {
        const key = `${p.provider}:${p.publicPixelId}`;
        switch (p.provider) {
          case 'meta':
            return <MetaPixel key={key} pixelId={p.publicPixelId} />;
          case 'ga4':
            return <Ga4Pixel key={key} measurementId={p.publicPixelId} />;
          case 'tiktok':
            return <TikTokPixel key={key} pixelCode={p.publicPixelId} />;
          case 'pinterest':
            return <PinterestPixel key={key} tagId={p.publicPixelId} />;
          case 'kwai':
            return <KwaiPixel key={key} pixelId={p.publicPixelId} />;
          // google_ads has no browser-side counterpart in our flow —
          // Enhanced Conversions ships server-only.
          default:
            return null;
        }
      })}
    </>
  );
}

function MetaPixel({ pixelId }: { pixelId: string }) {
  return (
    <>
      <Script
        id={`meta-pixel-${pixelId}`}
        strategy="afterInteractive"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: official Meta snippet, content is provider-controlled.
        dangerouslySetInnerHTML={{
          __html: `
            !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '${pixelId.replace(/[^0-9]/g, '')}');
            fbq('track', 'PageView');
          `,
        }}
      />
      {/* noscript fallback — required by Meta's spec so blocked-JS
          browsers still register a PageView. */}
      <noscript>
        <img
          height="1"
          width="1"
          alt=""
          style={{ display: 'none' }}
          src={`https://www.facebook.com/tr?id=${encodeURIComponent(pixelId)}&ev=PageView&noscript=1`}
        />
      </noscript>
    </>
  );
}

function Ga4Pixel({ measurementId }: { measurementId: string }) {
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
        strategy="afterInteractive"
      />
      <Script
        id={`ga4-${measurementId}`}
        strategy="afterInteractive"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: official GA4 snippet.
        dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            window.gtag = gtag;
            gtag('js', new Date());
            gtag('config', '${measurementId}');
          `,
        }}
      />
    </>
  );
}

function TikTokPixel({ pixelCode }: { pixelCode: string }) {
  return (
    <Script
      id={`tiktok-${pixelCode}`}
      strategy="afterInteractive"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: official TikTok snippet.
      dangerouslySetInnerHTML={{
        __html: `
          !function (w, d, t) {
            w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};
            ttq.load('${pixelCode.replace(/'/g, '')}');
            ttq.page();
          }(window, document, 'ttq');
        `,
      }}
    />
  );
}

function PinterestPixel({ tagId }: { tagId: string }) {
  return (
    <Script
      id={`pinterest-${tagId}`}
      strategy="afterInteractive"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: official Pinterest snippet.
      dangerouslySetInnerHTML={{
        __html: `
          !function(e){if(!window.pintrk){window.pintrk = function () {window.pintrk.queue.push(Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";var t=document.createElement("script");t.async=!0,t.src=e;var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}("https://s.pinimg.com/ct/core.js");
          pintrk('load', '${tagId.replace(/'/g, '')}');
          pintrk('page');
        `,
      }}
    />
  );
}

function KwaiPixel({ pixelId }: { pixelId: string }) {
  return (
    <Script
      id={`kwai-${pixelId}`}
      strategy="afterInteractive"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: official Kwai snippet (mirror of TikTok shape).
      dangerouslySetInnerHTML={{
        __html: `
          !function(w,d,t){w.KwaiAnalyticsObject=t;var kwaiq=w[t]=w[t]||[];kwaiq.methods=["page","track","identify","ready"];kwaiq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<kwaiq.methods.length;i++)kwaiq.setAndDefer(kwaiq,kwaiq.methods[i]);kwaiq.load=function(e){var n="https://s2.kwai.net/kos/s101/nlav11187/pixel/events.js";var o=document.createElement("script");o.type="text/javascript";o.async=!0;o.src=n+"?sdkid="+e;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};kwaiq.load('${pixelId.replace(/'/g, '')}');kwaiq.page();}(window,document,'kwaiq');
        `,
      }}
    />
  );
}

/**
 * Fire a tracked event across every loaded pixel. Use this from the
 * checkout flow at `initiate_checkout` / `add_payment_info` / `purchase`
 * lifecycle hooks. `eventId` (UUID) MUST match the server-side dispatch
 * so Meta dedupes.
 */
export function useFireEvent() {
  // Buffer events fired BEFORE pixels finish loading. `next/script`
  // strategy=afterInteractive can fire after the first event we want
  // (e.g. an instant PageView from a deep-link `?plan=`). Flushing
  // on a short interval keeps us simple without needing to wire each
  // provider's `.queue`.
  const bufferRef = useRef<{ name: string; params?: Record<string, unknown>; eventId?: string }[]>(
    [],
  );

  useEffect(() => {
    const id = setInterval(() => {
      if (bufferRef.current.length === 0) return;
      const drained = bufferRef.current.splice(0);
      for (const ev of drained) {
        fireNow(ev.name, ev.params, ev.eventId);
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  return (name: string, params?: Record<string, unknown>, eventId?: string) => {
    bufferRef.current.push({ name, params, eventId });
  };
}

function fireNow(name: string, params?: Record<string, unknown>, eventId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.fbq?.('track', name, params, eventId ? { eventID: eventId } : undefined);
  } catch {
    /* meta pixel not ready or blocked */
  }
  try {
    window.ttq?.track(name, params);
  } catch {
    /* tiktok pixel not ready */
  }
  try {
    window._pintrk?.('track', name.toLowerCase(), params);
  } catch {
    /* pinterest not ready */
  }
  try {
    window.kwaiq?.('track', name, params);
  } catch {
    /* kwai not ready */
  }
  try {
    window.gtag?.('event', name, params);
  } catch {
    /* gtag not ready */
  }
}
