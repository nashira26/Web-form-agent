import "dotenv-defaults/config";
import { createSession } from "./session";
import { runWorkflow } from "./workflow";
/**
 * Verify submission from the page state rather than trusting the model output.
 * The confirmation banner is transient, so we check after every action.
 */
const EVERY_MS = 5 * 60 * 1000;
const FORM_URL = "https://magical-medical-form.netlify.app/";
let inFlight = false;

async function tick() {
	if (inFlight) {
		console.warn("Previous run still going - skipping this tick.");
		return;
	}
	inFlight = true;
	const at = new Date().toISOString();
	const page = await createSession(FORM_URL, { headless: true });
	try {
		const result = await runWorkflow(page);
		console.log(
			`[${at}] ${result.success ? "OK" : "FAILED"} in ${result.steps} steps`
		);
	} catch (err) {
		console.error(`[${at}] threw:`, (err as Error).message);
	} finally {
		await page.context().browser()?.close();
		inFlight = false;
	}
}

console.log("Scheduler started - running every 5 minutes. Ctrl+C to stop.");
tick();
setInterval(tick, EVERY_MS);
