# Take Home Assignment

This project implements an AI agent that fills out and submits the form at:

https://magical-medical-form.netlify.app/

The agent uses Gemini to drive a Playwright-controlled Chromium browser. Instead of relying on hardcoded CSS selectors, it interacts with the page through a simplified accessibility snapshot generated at runtime.

## Setup

```bash
npm install
cp .env.example .env
```

Add Gemini API key to `.env`:

```text
GOOGLE_GENERATIVE_AI_API_KEY=gemini_key_here
```

## Running

Run the workflow once:

```bash
npm run dev
```

Override any default field:

```bash
npm run dev -- --firstName=Jane --lastName=Roe
```

Start the HTTP API:

```bash
npm run serve
```

Run the scheduler (every 5 minutes):

```bash
npm run schedule
```

---

## Architecture

The main workflow is in `workflow.ts`.

The agent follows a simple 'observe and act' loop:

1. Capture the current page state.
2. Build a simplified representation of the interactive elements.
3. Ask Gemini for the next action.
4. Execute the action with Playwright.
5. Capture the updated page state.
6. Repeat until the model signals completion.

The model does not receive the page HTML. Instead, `agent.ts` builds an accessibility-based snapshot containing only interactive elements, each assigned a temporary reference.

For example:

```text
[e2] textbox "First Name" (empty)

[e3] combobox "Gender"
     options: Select gender | Male | Female | Other | Prefer not to say
```

The model issues actions using these references (for example, `fill e2` or `select e3`). The tool layer resolves each reference back to the corresponding Playwright locator before executing the action.

References are regenerated after every interaction, so the model always works from the latest page snapshot.



## Features

### Form automation

The same set of tools handles:

- text inputs
- dropdowns
- buttons
- expandable sections

No page-specific selectors are exposed to the model.

### HTTP API

`server.ts` exposes:

- `POST /run`
- `GET /health`

`POST /run` accepts optional field overrides. Unknown fields return `400 Bad Request` rather than being ignored.

Example:

```bash
curl -X POST localhost:3000/run \
  -H "content-type:application/json" \
  -d '{"firstName":"Jane","lastName":"Roe"}'
```

### Configurable values

Default form values are defined in `workflow.ts` and can be overridden through:

- command-line arguments
- API requests

### Scheduled execution

`schedule.ts` runs the workflow every five minutes using `setInterval`.

To avoid overlapping runs, a new execution is skipped if the previous one is still in progress.

### Additional reliability checks

I added two checks beyond the required functionality.

**Input verification**

After every `fill` action, the value is read back from the page. If it doesn't match the expected value, the action is reported as a failure so the agent can retry.

**Submission verification**

The workflow is only considered successful after the confirmation banner appears on the page. Since the banner disappears after a short time, it is checked after every action rather than only once at the end.



## Notes

- `src/_internal/run.ts` is the CLI entry point and loads the environment before calling `main`.
- `server.ts` and `schedule.ts` load the environment independently.
- The model can be configured with the `MODEL_ID` environment variable. By default it uses `gemini-3.5-flash`.
- Gemini 3 tool calls include a thought signature that must be preserved. The workflow passes the model response parts back unchanged so subsequent tool calls remain valid.



## Project structure

```text
src/
  _internal/
    run.ts          CLI entry point
    setup.ts        Gemini model setup

  session.ts        Browser launcher
  main.ts           CLI interface
  agent.ts     Accessibility snapshot and Playwright tools
  workflow.ts       Agent loop, defaults and validation
  server.ts         HTTP API
  schedule.ts       Scheduler
```