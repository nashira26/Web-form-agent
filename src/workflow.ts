import type { Page } from "playwright";
import {
  clickElement,
  fillField,
  observe,
  selectOption,
} from "./agent.js";

const KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY!;

if (!KEY) {
	throw new Error("Missing GOOGLE_GENERATIVE_AI_API_KEY");
}
const MODEL = process.env.MODEL_ID ?? "gemini-3.5-flash-lite";

export type Variables = {
	firstName: string;
	lastName: string;
	dateOfBirth: string;
	medicalId: string;
	gender: string;
	bloodType: string;
	allergies: string;
	currentMedications: string;
	emergencyContactName: string;
	emergencyContactPhone: string;
};

export const DEFAULTS: Variables = {
	firstName: "John",
	lastName: "Doe",
	dateOfBirth: "1990-01-01",
	medicalId: "91927885",
	gender: "Female",
	bloodType: "O+",
	allergies: "None",
	currentMedications: "None",
	emergencyContactName: "Jane Doe",
	emergencyContactPhone: "416-555-0142",
};

export type RunResult = {
	success: boolean;
	verified: boolean;
	summary: string;
	steps: number;
	durationMs: number;
};

const SYSTEM = `You are a browser agent that fills out web forms.

HOW YOU SEE THE PAGE
- You never see HTML. You call tools and get back a list of elements.
- Each element has a ref like [e3]. Always act using a ref, never a CSS selector.

CRITICAL RULE ABOUT REFS
- Refs are renumbered every time the page changes. After ANY click, every old
  ref is meaningless. Use refs from the most recent page state you were shown.

ABOUT THIS FORM
- Only one section is open at a time. Opening one closes the previous one.
- That is expected. Values in a closed section are KEPT. Do not reopen a
  section to double-check it and do not refill it.
- Dropdowns list a placeholder first ("Select gender"). Never choose it.
- Date fields take YYYY-MM-DD even though they display as mm/dd/yyyy.

HOW TO WORK (be fast: every turn costs time)
1. The current page is given to you below the task. Every action also returns
   the updated page - do NOT call observe unless something looks wrong.
2. BATCH: in a single turn, call fill/select for EVERY field of the open
   section at once. Refs stay valid within a turn as long as nothing is
   clicked, so you may also add ONE click as the LAST call of the turn
   (e.g. to open the next section, or Submit). Never put anything after a click.
3. Each fill reports the value it read back. If one does not match, fix it.
4. When every section is done, click Submit. The click result shows the page.
5. Call finish exactly once, with what you actually saw.

Never invent a value that was not given to you.`;

function buildTask(v: Variables): string {
	return `Fill out the form at https://magical-medical-form.netlify.app/

Personal Information:
  First Name: ${v.firstName}
  Last Name: ${v.lastName}
  Date of Birth: ${v.dateOfBirth}
  Medical ID: ${v.medicalId}

Medical Information:
  Gender: ${v.gender}
  Blood Type: ${v.bloodType}
  Allergies: ${v.allergies}
  Current Medications: ${v.currentMedications}

Emergency Contact:
  Emergency Contact Name: ${v.emergencyContactName}
  Emergency Contact Phone: ${v.emergencyContactPhone}

Then submit and confirm it succeeded.`;
}
const stringParam = {
	type: "string",
};

// The array defines the available tools for the agent to interact with the web page.
const FUNCTIONS = [
	{
		name: "observe",
		description:
			"Look at the page. Returns every visible element with its ref, label and current value.",
	},
	{
		name: "fill",
		description:
			"Type a value into a text box or textarea. Reports the value it read back afterwards.",
		parameters: {
			type: "object",
			properties: { ref: stringParam, value: stringParam },
			required: ["ref", "value"],
		},
	},
	{
		name: "select",
		description: "Choose an option in a dropdown by its visible label.",
		parameters: {
			type: "object",
			properties: { ref: stringParam, option: stringParam },
			required: ["ref", "option"],
		},
	},
	{
		name: "click",
		description:
			"Click a button or section header. Opens a collapsed section. Refs change after this.",
		parameters: {
			type: "object",
			properties: { ref: stringParam },
			required: ["ref"],
		},
	},
	{
		name: "finish",
		description: "End the run once submitted and confirmed, or if stuck.",
		parameters: {
			type: "object",
			properties: { success: { type: "boolean" }, summary: stringParam },
			required: ["success", "summary"],
		},
	},
];

const SUCCESS_WORDS = [
	"success",
	"submitted",
	"thank you",
	"confirmation",
	"received",
];

/**
 * Additionals: independent verification.
 * Checks the page for submission confirmation independently of the model output.
 * The confirmation banner is temporary, so the first successful detection is kept.
 */
async function pollForConfirmation(page: Page): Promise<string | undefined> {
	try {
		const text: string = await page.evaluate(() => document.body.innerText);
		const hit = SUCCESS_WORDS.find((w) => text.toLowerCase().includes(w));
		if (!hit) return undefined;
		return (
			text
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.toLowerCase().includes(hit)) ?? hit
		);
	} catch {
		return undefined;
	}
}

// Must match the separator agent.ts's withState() puts before the page state.
const PAGE_MARKER = "--- PAGE NOW (refs below are the current ones) ---";

/** Removes the page-state section from a message's text / tool results in place. */
function stripPageState(msg: { role?: string; parts: any[] }) {
	if (msg.role === "model") return; // never touch model parts (thoughtSignature)
	const cut = (s: string) => {
		const i = s.indexOf(PAGE_MARKER);
		return i === -1 ? s : s.slice(0, i) + "(old page state omitted)";
	};
	for (const p of msg.parts) {
		if (typeof p.text === "string") p.text = cut(p.text);
		const r = p.functionResponse?.response;
		if (r && typeof r.result === "string") r.result = cut(r.result);
	}
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Calls Gemini, retrying transient failures (overloaded / rate limited / network)
 * with exponential backoff. Non-transient errors (bad key, bad request) throw at once.
 */
async function callGemini(contents: any[], maxAttempts = 6): Promise<any> {
	for (let attempt = 1; ; attempt++) {
		let status = 0;
		let error: unknown;
		try {
			const res = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						systemInstruction: { parts: [{ text: SYSTEM }] },
						contents,
						tools: [{ functionDeclarations: FUNCTIONS }],
						generationConfig: {
							temperature: 0,
							// Form filling needs little reasoning; low thinking cuts latency a lot.
							thinkingConfig: { thinkingLevel: "low" },
						},
					}),
				}
			);
			status = res.status;
			const data: any = await res.json();
			if (!data.error) return data;
			status = data.error.code ?? status;
			error = new Error(JSON.stringify(data.error));
		} catch (e) {
			error = e; // network error or non-JSON body
		}

		const transient = status === 0 || RETRYABLE.has(status);
		if (!transient || attempt >= maxAttempts) throw error;
		const delay =
			Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
		console.log(
			`  Gemini ${status || "network error"}, retrying in ${Math.round(
				delay / 1000
			)}s (attempt ${attempt}/${maxAttempts})`
		);
		await new Promise((r) => setTimeout(r, delay));
	}
}

/**
 * Runs the agent against an already-open page. The page comes from the
 * scaffold's createSession(), so the browser lifecycle stays owned by the
 * caller and this stays a pure agent loop.
 */
export async function runWorkflow(
	page: Page,
	overrides: Partial<Variables> = {},
	opts: { maxSteps?: number } = {}
): Promise<RunResult> {
	const v = { ...DEFAULTS, ...overrides };
	const maxSteps = opts.maxSteps ?? 40;
	const started = Date.now();

	let done: { success: boolean; summary: string } | undefined;
	let steps = 0;
	let confirmation: string | undefined;

	{
		async function runTool(name: string, args: any): Promise<string> {
			switch (name) {
				case "observe":
					return `${PAGE_MARKER}\n${await observe(page)}`;
				case "fill":
					return fillField(page, args.ref, args.value);
				case "select":
					return selectOption(page, args.ref, args.option);
				case "click":
					return clickElement(page, args.ref);
				case "finish":
					done = { success: args.success, summary: args.summary };
					return "Run ended.";
				default:
					return `No tool called ${name}.`;
			}
		}

		// Seed the first page state so the model can act on turn 1 without observing.
		const contents: any[] = [
			{
				role: "user",
				parts: [
					{
						text: `${buildTask(v)}\n\n${PAGE_MARKER}\n${await observe(page)}`,
					},
				],
			},
		];

		for (let step = 1; step <= maxSteps && !done; step++) {
			steps = step;
			const data = await callGemini(contents);

			const parts = data.candidates?.[0]?.content?.parts ?? [];
			// Preserve the response parts so Gemini's thoughtSignature is carried forward..
			contents.push({ role: "model", parts });

			const calls = parts.filter((p: any) => p.functionCall);
			if (calls.length === 0) break;

			const responses = [];
			for (const c of calls) {
				const { name, args } = c.functionCall;
				console.log(`  step ${step}: ${name}`, JSON.stringify(args ?? {}));
				// A Playwright failure (timeout, detached element) is reported back to
				// the model so it can recover, instead of crashing the whole run.
				const result = await runTool(name, args ?? {}).catch(
					(e: any) => `ERROR running ${name}: ${e?.message ?? e}`
				);
				if (!confirmation) {
					confirmation = await pollForConfirmation(page);
					if (confirmation) {
						console.log("  [confirmed]", confirmation);
						// The model can't see banner text (snapshots list controls only), so
						// it would keep observing or even re-submit. End the run here.
						done ??= {
							success: true,
							summary: "Filled all sections and submitted the form.",
						};
					}
				}
				responses.push({
					functionResponse: { name, response: { result } },
				});
			}
			// Old page snapshots are stale and only add tokens (= latency). Keep just
			// the newest one: strip it from everything already in history and from
			// all but the last response of this batch.
			for (const msg of contents) stripPageState(msg);
			responses.forEach((r, i) => {
				if (i < responses.length - 1) stripPageState({ parts: [r] });
			});
			contents.push({ role: "user", parts: responses });
		}

		confirmation ??= await pollForConfirmation(page);
		const verified = Boolean(confirmation);

		return {
			success: Boolean(done?.success) && verified,
			verified,
			summary: done
				? done.success && !verified
					? `${done.summary}\n\nNOTE: agent reported success but no confirmation was seen on the page. Treated as failure.`
					: verified
					? `${done.summary}\n\nConfirmed on page: "${confirmation}"`
					: done.summary
				: `Hit the ${maxSteps}-step limit without finishing.`,
			steps,
			durationMs: Date.now() - started,
		};
	}
}
