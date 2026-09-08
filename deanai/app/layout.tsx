import type { Metadata } from "next";
import { fontVars } from "@/lib/fonts";
import { AppToaster } from "@/components/app-toaster";
import { ClientErrorLogger } from "@/components/client-error-logger";
import { PwaRegistration } from "@/components/pwa-registration";
import { DesktopWorkspace } from "@/components/desktop-workspace";
import brandIcon from "@/assets/brand/icon-512.png";
import socialBanner from "@/assets/brand/github-social-banner.png";
import "./globals.css";

export const metadata: Metadata = {
    metadataBase: new URL(process.env.SITE_URL || "http://localhost:3000"),
    title: {
      default: process.env.NEXT_PUBLIC_LOCAL_DESKTOP === "1" ? "dean-nai" : "dean-nai — NovelAI 本地生图工作台",
      template: process.env.NEXT_PUBLIC_LOCAL_DESKTOP === "1" ? "%s · dean-nai" : "%s · dean-nai",
    },
    description:
      "面向个人本地使用的 NovelAI 生图、提示词资料库与图片管理工作台。",
    applicationName: process.env.NEXT_PUBLIC_LOCAL_DESKTOP === "1" ? "dean-nai" : "dean-nai",
    icons: {
      icon: [{ url: brandIcon.src, type: "image/png", sizes: "512x512" }],
      apple: [{ url: brandIcon.src, type: "image/png", sizes: "512x512" }],
    },
    openGraph: {
      type: "website",
      siteName: "dean-nai",
      title: "dean-nai — NovelAI 本地生图工作台",
      description: "整合生图、提示词资料库、标签词库、画廊与本地数据管理。",
      images: [{ url: socialBanner.src, width: 1280, height: 640, alt: "dean-nai — NovelAI 本地生图工作台" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "dean-nai — NovelAI 本地生图工作台",
      description: "整合生图、提示词资料库、标签词库、画廊与本地数据管理。",
      images: [socialBanner.src],
    },
};

// No-flash theme init: read the saved mode/accent before first paint so the page
// never flips from the default dark theme. Kept inline (not a component) so it runs
// synchronously in <head>. Mirrors the data-mode / data-accent contract in globals.css.
const THEME_NO_FLASH = `
(function () {
  try {
    var d = document.documentElement;
    var m = localStorage.getItem("nya-mode") || "dark";
    var a = localStorage.getItem("nya-accent");
    d.setAttribute("data-mode", m);
    if (a) d.setAttribute("data-accent", a);
    if (a === "custom") {
      var c = localStorage.getItem("nya-accent-color");
      if (/^#[0-9a-f]{6}$/i.test(c || "")) {
        d.style.setProperty("--accent-custom", c);
        var rgb = [1, 3, 5].map(function (i) { return parseInt(c.slice(i, i + 2), 16) / 255; });
        var linear = rgb.map(function (v) {
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        var luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
        d.style.setProperty("--on-accent", luminance > 0.46 ? "#171719" : "#ffffff");
      }
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const isDesktop = process.env.NEXT_PUBLIC_LOCAL_DESKTOP === "1";
  return (
    <html lang="zh-CN" className={`${fontVars} h-full`} data-mode="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_NO_FLASH }} />
      </head>
      <body className={`flex min-h-full flex-col bg-bg text-fg antialiased ${isDesktop ? "pl-16" : ""}`}>
        <ClientErrorLogger />
        <PwaRegistration />
        {isDesktop ? <DesktopWorkspace /> : children}
        <AppToaster />
      </body>
    </html>
  );
}
