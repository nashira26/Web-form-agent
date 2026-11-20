import type { Page } from "playwright";

/**
 * A compact description of one interactive element on the page, as shown to
 * the model. `ref` is the stable handle the model uses to target it in actions.
 */
export type Element = {
	ref: string;
	role: string;
	name: string;
	tag: string;
	type?: string;
	value?: string;
	options?: string[];
};

/**
 * Scans the page for visible interactive elements (inputs, selects, textareas,
 * buttons, links), tags each with a `data-agent-ref` attribute so it can be
 * located later, and returns a description of each one. The accessible name is
 * taken from aria-label, then a matching <label>, then placeholder, then text.
 * Refs are reassigned on every call, so they are only valid for the latest snapshot.
 */
export async function snapshot(page: Page): Promise<Element[]> {
	return page.evaluate(() => {
		const found: any[] = [];
		let counter = 0;
		const nodes = document.querySelectorAll(
			"input:not([type=hidden]), select, textarea, button, a[href]"
		);
		for (const el of Array.from(nodes)) {
			const box = el.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			const ref = "e" + ++counter;
			el.setAttribute("data-agent-ref", ref);
			let name = el.getAttribute("aria-label") || "";
			if (!name && el.id) {
				name =
					document
						.querySelector(`label[for="${el.id}"]`)
						?.textContent?.trim() || "";
			}
			if (!name) name = el.getAttribute("placeholder") || "";
			if (!name) name = (el.textContent || "").trim();
			const tag = el.tagName.toLowerCase();
			const type = (el as HTMLInputElement).type || "";
			let role = "textbox";
			if (tag === "button" || type === "submit") role = "button";
			else if (tag === "a") role = "link";
			else if (tag === "select") role = "combobox";
			else if (type === "checkbox") role = "checkbox";
			const entry: any = { ref, role, name, tag, type };
			if (tag === "select")
				entry.options = Array.from((el as HTMLSelectElement).options).map(
					(o) => o.text
				);
			else if (tag === "input" || tag === "textarea")
				entry.value = (el as HTMLInputElement).value;
			found.push(entry);
		}
		return found;
	});
}

/**
 * Formats a snapshot as plain text for the model: one line per element with its
 * ref, role and name, plus its current value (or "(empty)") and, for selects,
 * the list of available options.
 */
export function render(elements: Element[]): string {
	return elements
		.map((el) => {
			let line = `[${el.ref}] ${el.role} "${el.name}"`;
			if (el.value !== undefined)
				line += el.value ? ` = "${el.value}"` : ` (empty)`;
			if (el.options) line += `\n      options: ${el.options.join(" | ")}`;
			return line;
		})
		.join("\n");
}

/**
 * Returns the fresh page state after each action, so the model doesn't have to
 * call observe separately between steps.
 */
async function withState(page: Page, message: string): Promise<string> {
	await page.waitForTimeout(150);
	return `${message}\n\n--- PAGE NOW (refs below are the current ones) ---\n${render(
		await snapshot(page)
	)}`;
}

/**
 * Takes a fresh snapshot (re-tagging elements) and returns a Playwright locator
 * for the given ref along with its metadata. `meta` is undefined if the ref no
 * longer exists on the page.
 */
async function find(page: Page, ref: string) {
	const elements = await snapshot(page);
	return {
		locator: page.locator(`[data-agent-ref="${ref}"]`),
		meta: elements.find((e) => e.ref === ref),
	};
}

/** Returns the current page state as text, without performing any action. */
export async function observe(page: Page): Promise<string> {
	return render(await snapshot(page));
}

/**
 * Types `value` into the text field identified by `ref`, then reads the value
 * back to confirm it took effect. Returns a result message plus the new page state.
 */
export async function fillField(
	page: Page,
	ref: string,
	value: string
): Promise<string> {
	const { locator, meta } = await find(page, ref);
	if (!meta) return `No element ${ref}. Use refs from the latest page state.`;
	await locator.fill(value);
	// Read the value back. A fill that silently did not stick is the most common
	// failure in form automation and stays invisible until submit.
	const actual = await locator.inputValue().catch(() => null);
	if (actual !== value) {
		return withState(
			page,
			`WARNING: filled "${meta.name}" but it reads "${actual}".`
		);
	}
	return withState(page, `Filled "${meta.name}" with "${value}". Verified.`);
}

/**
 * Chooses `option` in the dropdown identified by `ref`. For a native <select>,
 * it matches an option label exactly (case-insensitive) or by substring. For a
 * custom dropdown, it clicks to open it and then clicks the first
 * [role="option"] or <li> whose text contains `option`.
 */
export async function selectOption(
	page: Page,
	ref: string,
	option: string
): Promise<string> {
	const { locator, meta } = await find(page, ref);
	if (!meta) return `No element ${ref}. Use refs from the latest page state.`;
	if (meta.tag === "select") {
		const options = meta.options || [];
		const match =
			options.find(
				(o) => o.toLowerCase().trim() === option.toLowerCase().trim()
			) ?? options.find((o) => o.toLowerCase().includes(option.toLowerCase()));
		if (!match)
			return `No option like "${option}". Available: ${options.join(" | ")}`;
		await locator.selectOption({ label: match });
		return withState(page, `Selected "${match}" in "${meta.name}".`);
	}
	await locator.click();
	await page.waitForTimeout(300);
	const opts = page.locator('[role="option"], li');
	const count = await opts.count();
	for (let i = 0; i < count; i++) {
		const text = (await opts.nth(i).innerText()).trim();
		if (text.toLowerCase().includes(option.toLowerCase())) {
			await opts.nth(i).click();
			return withState(page, `Selected "${text}" in "${meta.name}".`);
		}
	}
	return `Opened "${meta.name}" but found no option matching "${option}".`;
}

/**
 * Clicks the element identified by `ref` (button, link, checkbox, etc.), waits
 * briefly for the page to react, and returns the new page state.
 */
export async function clickElement(page: Page, ref: string): Promise<string> {
	const { locator, meta } = await find(page, ref);
	if (!meta) return `No element ${ref}. Use refs from the latest page state.`;
	await locator.click();
	await page.waitForTimeout(400);
	return withState(page, `Clicked "${meta.name}".`);
}
