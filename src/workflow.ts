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
const MODEL = process.env.MODEL_ID ?? "gemini-3.5-flash";

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

HOW TO WORK
1. Observe once at the start. After that, every action already returns the
   updated page - do NOT call observe again unless something looks wrong.
2. After each fill, the result reports the value it read back. If it does not
   match what you asked for, fix it before moving on.
3. Fill a section completely, then open the next one.
4. When every section is done, click Submit, then observe to confirm.
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
		parameters: { type: "object", properties: { ref: stringParam }, required: ["ref"] },
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
					return observe(page);
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

		const contents: any[] = [{ role: "user", parts: [{ text: buildTask(v) }] }];

		for (let step = 1; step <= maxSteps && !done; step++) {
			steps = step;
			const res = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						systemInstruction: { parts: [{ text: SYSTEM }] },
						contents,
						tools: [{ functionDeclarations: FUNCTIONS }],
						generationConfig: { temperature: 0 },
					}),
				}
			);

			const data: any = await res.json();
			if (data.error) throw new Error(JSON.stringify(data.error));

			const parts = data.candidates?.[0]?.content?.parts ?? [];
      // Preserve the response parts so Gemini's thoughtSignature is carried forward..
			contents.push({ role: "model", parts });

			const calls = parts.filter((p: any) => p.functionCall);
			if (calls.length === 0) break;

			const responses = [];
			for (const c of calls) {
				const { name, args } = c.functionCall;
				console.log(`  step ${step}: ${name}`, JSON.stringify(args ?? {}));
				const result = await runTool(name, args ?? {});
				if (!confirmation) {
					confirmation = await pollForConfirmation(page);
					if (confirmation) console.log("  [confirmed]", confirmation);
				}
				responses.push({
					functionResponse: { name, response: { result } },
				});
			}
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
