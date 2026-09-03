import { Head, Html, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon-192.png" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <meta name="application-name" content="Bhawani One" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* Reads the saved theme before first paint, so a dark-mode user never sees
            a white flash while React hydrates. Light mode is the hard default: a
            visitor with no saved preference gets 'light' pinned explicitly rather
            than falling through to the OS's prefers-color-scheme, which is what
            was silently handing dark-OS users a dark app on their very first visit. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('erp_theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}else if(t!=='system'){document.documentElement.setAttribute('data-theme','light');}var l=localStorage.getItem('erp_lang');if(l){document.documentElement.lang=l;}}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`,
          }}
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
