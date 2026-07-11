import type { ReactNode } from "react";

export const metadata = { title: "BeTheHouse — demo" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          background: "#0b0e14",
          color: "#e6e6e6",
          margin: 0,
          padding: "2rem",
        }}
      >
        <h1 style={{ fontSize: "1.2rem" }}>
          🎲 BeTheHouse <span style={{ opacity: 0.5 }}>— permissionless sportsbook demo</span>
        </h1>
        {children}
      </body>
    </html>
  );
}
