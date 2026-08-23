import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "hwp-editor playground",
  description: "Smoke-test harness for @hwp-editor/server",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: "monospace", margin: 24 }}>{children}</body>
    </html>
  );
}
