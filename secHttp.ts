// The real HttpGet implementation for fundamentalsProvider.ts, wired to
// Obsidian's requestUrl the same way priceProvider.ts already talks to
// Yahoo — it runs outside the CORS-restricted webview on both desktop and
// mobile, unlike a browser fetch(). Deliberately kept in its own file and
// never imported by fundamentalsProvider.ts or its tests: importing
// "obsidian" (type declarations only, no runtime JS outside the Obsidian
// app) breaks Vite's dependency scan for any file that pulls it in, even
// indirectly — see fundamentalsProvider.ts's header comment. Only view.ts
// should import this file.
import { requestUrl } from "obsidian";
import type { HttpGet } from "./fundamentalsProvider";

export const secHttpGet: HttpGet = async (url, headers) => {
	const res = await requestUrl({ url, headers, throw: false });
	return { status: res.status, json: res.json };
};
