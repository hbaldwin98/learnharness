"use client";
// Fork feature: phone layout for remote control (docs/remote-control.md).
// Upstream components call into this file through small hooks; the visual
// rules live in app/phone.css, keyed on html[data-lh-phone].

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { installRemotePwa } from "@/components/remote-upload";

export const PHONE_QUERY = "(max-width: 767px)";

/** Synchronous check for mount-time decisions (false on the server). */
export function isPhone(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true;
}

/** Live phone-width flag; also mirrors it onto <html data-lh-phone> for CSS. */
// Read synchronously on client renders (a chat opened from the sidebar is
// windowed on its FIRST render, never rendered whole); false only while
// hydrating server HTML.
const subscribeWidth = (cb: () => void) => {
	if (typeof window.matchMedia !== "function") return () => {};
	const mq = window.matchMedia(PHONE_QUERY);
	mq.addEventListener("change", cb);
	return () => mq.removeEventListener("change", cb);
};

export function usePhone(): boolean {
	const phone = useSyncExternalStore(subscribeWidth, isPhone, () => false);
	useEffect(() => {
		installRemotePwa(); // remote-control pages become an installable PWA (any width)
		if (typeof window.matchMedia !== "function") return; // jsdom / very old engines
		const mq = window.matchMedia(PHONE_QUERY);
		const apply = () => {
			if (mq.matches) document.documentElement.dataset.lhPhone = "";
			else delete document.documentElement.dataset.lhPhone;
		};
		apply();
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, []);
	return phone;
}

/** On phones the sidebar is a drawer: navigating closes it. */
export function usePhoneDrawerAutoClose(phone: boolean, open: boolean, close: () => void) {
	const pathname = usePathname();
	const last = useRef(pathname);
	useEffect(() => {
		if (last.current === pathname) return;
		last.current = pathname;
		if (phone && open) close();
	}, [pathname, phone, open, close]);
	// Opening a modal dialog (Settings, …) from the drawer closes the drawer.
	useEffect(() => {
		if (!phone || !open) return;
		const obs = new MutationObserver(() => {
			if (document.querySelector('[role="dialog"][aria-modal="true"]')) close();
		});
		obs.observe(document.body, { childList: true });
		return () => obs.disconnect();
	}, [phone, open, close]);
}

/** Phones: coalesce a re-render trigger to at most once per animation frame
 *  (streaming fires one per chunk; a long chat re-render costs ~0.5s on a
 *  phone). Desktop gets `fn` back unchanged. */
export function frameBatched(fn: () => void): () => void {
	if (!isPhone() || typeof requestAnimationFrame !== "function") return fn;
	let queued = false;
	return () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			fn();
		});
	};
}

/** How many message groups a phone renders at first, and per "Show earlier". */
export const PHONE_WINDOW_STEP = 4;

/** Phones render only the last few message groups. Returns the first index
 *  to render (0 on desktop) and the "Show earlier messages" button. */
export function usePhoneMessageWindow(count: number): { start: number; earlier: ReactNode } {
	const phone = usePhone();
	const [shown, setShown] = useState(PHONE_WINDOW_STEP);
	const start = phone ? Math.max(0, count - shown) : 0;
	const earlier = start > 0 ? (
		<button
			type="button"
			data-testid="phone-show-earlier"
			className="mx-auto rounded-full border border-border px-4 py-1.5 text-sm text-muted-foreground"
			onClick={() => setShown((n) => n + PHONE_WINDOW_STEP)}
		>
			Show earlier messages
		</button>
	) : null;
	return { start, earlier };
}

/** Tap-outside scrim behind the open drawer. */
export function PhoneDrawerBackdrop({ show, onClose }: { show: boolean; onClose: () => void }) {
	if (!show) return null;
	return <button type="button" aria-label="Close sidebar" className="lh-phone-backdrop" onClick={onClose} />;
}
