/**
 * Graphite theme fonts (fork-owned; see app/theme/graphite.css).
 *
 * Kept out of app/layout.tsx so the upstream file only gains one import and
 * one className — the smallest possible merge surface. The variables are
 * consumed by graphite.css, never by components directly.
 */
import { Geist, Geist_Mono } from "next/font/google";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

/** Font-variable classes for <html>. */
export const graphiteFontVariables = `${sans.variable} ${mono.variable}`;
