import type { Metadata } from "next";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
import "./themes.css";
import "./documents.css";
import "@/lib/kit/chart.css";
import "./tracely.css";
import "./traces.css";
import "./runs.css";
export const metadata: Metadata = {
  icons: { icon: "/icon.svg" },
  title: "Parallax — Research, in perspective.",
  description:
    "Your private AI safety research observatory. Experiments, evidence, and the ideas between them.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('parallax.theme');if(['moss','glacier','iris','paper'].includes(t))document.documentElement.dataset.theme=t}catch(e){}})()`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
