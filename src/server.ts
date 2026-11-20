import "dotenv-defaults/config";
import { createServer } from "node:http";
import { createSession } from "./session";
import { DEFAULTS, runWorkflow } from "./workflow";

// HTTP wrapper around the workflow runner.
const PORT = Number(process.env.PORT ?? 3000);
const FORM_URL = "https://magical-medical-form.netlify.app/";

createServer(async (req, res) => {
	const json = (code: number, body: unknown) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body, null, 2));
	};

	if (req.method === "GET" && req.url === "/health") {
		return json(200, { ok: true, variables: Object.keys(DEFAULTS) });
	}

	if (req.method === "POST" && req.url === "/run") {
		let raw = "";
		for await (const chunk of req) raw += chunk;

		let overrides: any = {};
		if (raw.trim()) {
			try {
				overrides = JSON.parse(raw);
			} catch {
				return json(400, { error: "Body must be valid JSON." });
			}
    }
    
		// Reject invalid variable names instead of silently ignoring them.
		const unknown = Object.keys(overrides).filter((k) => !(k in DEFAULTS));
		if (unknown.length) {
			return json(400, { error: `Unknown variables: ${unknown.join(", ")}` });
		}

		console.log("Run requested:", overrides);
		const page = await createSession(FORM_URL, { headless: true });
		try {
			const result = await runWorkflow(page, overrides);
			return json(result.success ? 200 : 422, result);
		} catch (error) {
      console.error(error);
      return json(500, {error: "Internal server error"});
		} finally {
			await page.context().browser()?.close();
		}
	}

	json(404, { error: "POST /run or GET /health" });
}).listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
