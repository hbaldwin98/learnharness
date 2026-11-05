"use client";
// Fork feature: phone layout for remote control (docs/remote-control.md).
// Upstream components call into this file through small hooks; the visual
// rules live in app/phone.css, keyed on html[data-lh-phone].

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { installRemotePwa } from "@/components/remote-upload";

export const PHONE_QUERY = "(max-width: 767px)";

/** Synchronous check for mount-time decisions (false on the server). */
export function isPhone(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true;
}

/** Live phone-width flag; also mirrors it onto <html data-lh-phone> for CSS. */
export function usePhone(): boolean {
	const [phone, setPhone] = useState(false);
	useEffect(() => {
		installRemotePwa(); // remote-control pages become an installable PWA (any width)
		if (typeof window.matchMedia !== "function") return; // jsdom / very old engines
		const mq = window.matchMedia(PHONE_QUERY);
		const apply = () => {
			setPhone(mq.matches);
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

/** Tap-outside scrim behind the open drawer. */
export function PhoneDrawerBackdrop({ show, onClose }: { show: boolean; onClose: () => void }) {
	if (!show) return null;
	return <button type="button" aria-label="Close sidebar" className="lh-phone-backdrop" onClick={onClose} />;
}
