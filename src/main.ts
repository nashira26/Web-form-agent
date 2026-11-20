import { createSession } from "./session";
import { DEFAULTS, runWorkflow, type Variables } from "./workflow";

const FORM_URL = "https://magical-medical-form.netlify.app/";

/**
 * This is the entry point reached via `npm run dev` (src/_internal/run.ts -> main).
 */
function parseArgs(): Partial<Variables> {
	const vars: Record<string, string> = {};
	for (const arg of process.argv.slice(2)) {
		if (!arg.startsWith("--")) continue;
		const [k, val] = arg.slice(2).split("=");
		if (val !== undefined && k in DEFAULTS) vars[k] = val;
	}
	return vars as Partial<Variables>;
}

export async function main() {
	const overrides = parseArgs();

	// The scaffold's createSession launches Chromium and navigates for us,
	// giving a ready Playwright page.
	const page = await createSession(FORM_URL);
	const result = await runWorkflow(page, overrides);

	// Log the result to the console
	// exit with a non-zero code if it failed.

	console.log(
		`\n${result.success ? "OK" : "FAILED"} — ${
			result.steps
		} steps, ${Math.round(result.durationMs / 1000)}s`
	);
	console.log(result.summary);

	await page.context().browser()?.close();
	process.exit(result.success ? 0 : 1);
}
