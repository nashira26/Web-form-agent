import type { Page } from "playwright";

export type Element = {
	ref: string;
	role: string;
	name: string;
	tag: string;
	type?: string;
	value?: string;
	options?: string[];
};

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

async function find(page: Page, ref: string) {
	const elements = await snapshot(page);
	return {
		locator: page.locator(`[data-agent-ref="${ref}"]`),
		meta: elements.find((e) => e.ref === ref),
	};
}

export async function observe(page: Page): Promise<string> {
	return render(await snapshot(page));
}

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

export async function clickElement(page: Page, ref: string): Promise<string> {
	const { locator, meta } = await find(page, ref);
	if (!meta) return `No element ${ref}. Use refs from the latest page state.`;
	await locator.click();
	await page.waitForTimeout(400);
	return withState(page, `Clicked "${meta.name}".`);
}
