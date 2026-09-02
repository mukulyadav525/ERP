import { Head, Html, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon-192.png" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <meta name="application-name" content="Hardware ERP" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* Reads the saved theme before first paint, so a dark-mode user never sees
            a white flash while React hydrates. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('erp_theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}var l=localStorage.getItem('erp_lang');if(l){document.documentElement.lang=l;}}catch(e){}})();`,
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
