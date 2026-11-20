import { chromium, Page } from "playwright";

export async function createSession(
	url: string,
	opts: { headless?: boolean } = {}
): Promise<Page> {
	const browser = await chromium.launch({
		args: ["--window-size=1366,768"],
		// Default stays visible (as the scaffold shipped it) for `npm run dev`;
		// the API and scheduler pass headless: true.
		headless: opts.headless ?? false,
	});
	const activePage = await browser.newPage();
	if (!activePage) {
		throw new Error("No page found");
	}

	await activePage.goto(url);

	return activePage;
}
