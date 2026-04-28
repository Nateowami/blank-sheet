#!/usr/bin/env -S deno run --allow-all

/**
 * agent.ts — A lightweight LLM agent harness that connects an Ollama model
 * to a web page via Playwright. The model reads an objective from a markdown
 * file, then repeatedly interacts with the browser by issuing simple JSON
 * actions. A full conversation log (with screenshots) is saved as markdown.
 */

import { chromium, type Page, type Browser } from "npm:playwright@1.52.0";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";

// ─── Configuration ──────────────────────────────────────────────────────────

const OLLAMA_BASE = Deno.env.get("OLLAMA_BASE") ?? "http://localhost:11434";
const MODEL = Deno.env.get("OLLAMA_MODEL") ?? "gemma3:27b";
const MAX_TURNS = parseInt(Deno.env.get("MAX_TURNS") ?? "40", 10);
const ACTION_DELAY_MS = parseInt(Deno.env.get("ACTION_DELAY_MS") ?? "2000", 10);
const OBJECTIVE_FILE = Deno.args[0] ?? "objective.md";
const VIEWPORT = { width: 1280, height: 900 };

// ─── Types ──────────────────────────────────────────────────────────────────

interface Action {
  action: string;
  [key: string]: unknown;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[]; // base64-encoded images
}

// ─── Ollama API ─────────────────────────────────────────────────────────────

async function chatOllama(
  messages: OllamaMessage[],
): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.message?.content ?? "";
}

// ─── Page State ─────────────────────────────────────────────────────────────

async function getPageState(page: Page): Promise<string> {
  const url = page.url();
  const title = await page.title();

  // Gather interactive elements and visible text, evaluated in-browser.
  const info = await page.evaluate(() => {
    const interactiveSelectors =
      'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [tabindex]';
    const els = Array.from(document.querySelectorAll(interactiveSelectors));

    const interactive: string[] = [];
    for (const el of els) {
      // Skip hidden elements
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") ?? "";
      const text = (el.textContent ?? "").trim().slice(0, 80).replace(/\s+/g, " ");
      const placeholder = el.getAttribute("placeholder") ?? "";
      const ariaLabel = el.getAttribute("aria-label") ?? "";
      const role = el.getAttribute("role") ?? "";
      const value = (el as HTMLInputElement).value ?? "";

      let desc = `<${tag}`;
      if (type) desc += ` type="${type}"`;
      if (role) desc += ` role="${role}"`;
      if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
      if (placeholder) desc += ` placeholder="${placeholder}"`;
      if (value) desc += ` value="${value}"`;
      desc += `>`;
      if (text && tag !== "input" && tag !== "textarea") desc += ` "${text}"`;

      interactive.push(desc);
    }

    // Get some visible body text (truncated)
    const bodyText = (document.body?.innerText ?? "").slice(0, 3000).replace(/\n{3,}/g, "\n\n");

    return { interactive: interactive.slice(0, 80), bodyText };
  });

  let state = `## Current page state\n`;
  state += `- **URL**: ${url}\n`;
  state += `- **Title**: ${title}\n\n`;
  state += `### Interactive elements (first ${info.interactive.length}):\n`;
  for (const el of info.interactive) {
    state += `- ${el}\n`;
  }
  state += `\n### Visible text (truncated):\n\`\`\`\n${info.bodyText}\n\`\`\`\n`;
  return state;
}

// ─── Screenshot ─────────────────────────────────────────────────────────────

async function takeScreenshot(
  page: Page,
  runDir: string,
  turn: number,
): Promise<string> {
  const filename = `turn-${String(turn).padStart(3, "0")}.png`;
  const filepath = path.join(runDir, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  return filepath;
}

async function screenshotToBase64(filepath: string): Promise<string> {
  const bytes = await Deno.readFile(filepath);
  return base64Encode(bytes);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ─── Actions ────────────────────────────────────────────────────────────────

const ACTION_HELP: Record<string, string> = {
  click:
    'Click an element by its visible text, aria-label, or placeholder.\n  Format: {"action": "click", "text": "Log in"}\n  Optional: {"action": "click", "text": "Submit", "index": 0} when multiple matches exist.',
  type:
    'Type text into an input/textarea identified by placeholder, aria-label, or nearby label text.\n  Format: {"action": "type", "text": "search box placeholder or label", "input": "hello world"}\n  Optional: add "submit": true to press Enter after typing.',
  scroll:
    'Scroll the page up or down.\n  Format: {"action": "scroll", "direction": "down"}\n  Valid directions: "up", "down".',
  goto:
    'Navigate to a URL.\n  Format: {"action": "goto", "url": "https://example.com"}',
  back:
    'Go back to the previous page.\n  Format: {"action": "back"}',
  wait:
    'Wait for a specified number of seconds (max 10).\n  Format: {"action": "wait", "seconds": 3}',
  done:
    'Indicate you have completed the objective.\n  Format: {"action": "done", "summary": "Here is what I found: ..."}',
  help:
    'Get help on a specific action.\n  Format: {"action": "help", "topic": "click"}\n  Omit "topic" to list all actions.',
};

const AVAILABLE_ACTIONS = Object.keys(ACTION_HELP);

async function executeAction(
  page: Page,
  action: Action,
): Promise<string> {
  switch (action.action) {
    case "click":
      return await doClick(page, action);
    case "type":
      return await doType(page, action);
    case "scroll":
      return await doScroll(page, action);
    case "goto":
      return await doGoto(page, action);
    case "back":
      return await doBack(page);
    case "wait":
      return await doWait(action);
    case "done":
      return doDone(action);
    case "help":
      return doHelp(action);
    default:
      return `❌ Unknown action "${action.action}". Available actions: ${AVAILABLE_ACTIONS.join(", ")}. Use {"action": "help"} for details.`;
  }
}

async function doClick(page: Page, action: Action): Promise<string> {
  const text = action.text as string | undefined;
  if (!text) {
    return `❌ "click" requires a "text" field — the visible text, aria-label, or placeholder of the element to click.\n  Example: {"action": "click", "text": "Log in"}`;
  }

  // Build locator: try text, then aria-label, then placeholder
  const exactText = page.locator(
    `text="${text}", [aria-label="${text}"], [placeholder="${text}"], [title="${text}"], [alt="${text}"]`,
  );

  // Also try a case-insensitive contains match as a fallback
  const looseText = page.getByText(text, { exact: false });

  // Determine which locator to use
  let locator = exactText;
  let count = await exactText.count();

  if (count === 0) {
    locator = looseText;
    count = await looseText.count();
  }

  if (count === 0) {
    return `❌ No element found matching text "${text}". Check the interactive elements list and try a different text value.`;
  }

  const index = (action.index as number | undefined) ?? 0;
  if (count > 1 && action.index === undefined) {
    // Gather descriptions of matching elements so the model can pick
    const descriptions: string[] = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = locator.nth(i);
      const tag = await el.evaluate((e) => e.tagName.toLowerCase());
      const innerText = await el.evaluate((e) =>
        (e.textContent ?? "").trim().slice(0, 60),
      );
      descriptions.push(`  [${i}] <${tag}> "${innerText}"`);
    }
    return `⚠️ Multiple elements (${count}) match "${text}". Please specify which one with "index":\n${descriptions.join("\n")}\n  Example: {"action": "click", "text": "${text}", "index": 0}`;
  }

  if (index >= count) {
    return `❌ Index ${index} is out of range. Only ${count} element(s) match "${text}". Use index 0 to ${count - 1}.`;
  }

  try {
    await locator.nth(index).click({ timeout: 5000 });
    return `✅ Clicked element matching "${text}"${count > 1 ? ` (index ${index})` : ""}.`;
  } catch (e) {
    return `❌ Failed to click "${text}": ${(e as Error).message}. The element may be obscured or not clickable.`;
  }
}

async function doType(page: Page, action: Action): Promise<string> {
  const text = action.text as string | undefined;
  const input = action.input as string | undefined;
  if (!text) {
    return `❌ "type" requires a "text" field — the placeholder, aria-label, or label of the input.\n  Example: {"action": "type", "text": "Search", "input": "hello"}`;
  }
  if (input === undefined) {
    return `❌ "type" requires an "input" field — the text to type.\n  Example: {"action": "type", "text": "Search", "input": "hello"}`;
  }

  // Try to find by placeholder, aria-label, or label
  const byPlaceholder = page.locator(`[placeholder="${text}"], [aria-label="${text}"]`);
  const byLabel = page.getByLabel(text, { exact: false });

  let locator = byPlaceholder;
  let count = await byPlaceholder.count();

  if (count === 0) {
    locator = byLabel;
    count = await byLabel.count();
  }

  // Fallback: look for any input/textarea near the matching text
  if (count === 0) {
    const byRole = page.getByRole("textbox", { name: text });
    count = await byRole.count();
    if (count > 0) locator = byRole;
  }

  if (count === 0) {
    return `❌ No input/textarea found matching "${text}". Check the interactive elements list for the correct placeholder, aria-label, or label.`;
  }

  const index = (action.index as number | undefined) ?? 0;
  if (count > 1 && action.index === undefined) {
    return `⚠️ Multiple inputs (${count}) match "${text}". Specify which one with "index" (0-${count - 1}).`;
  }

  try {
    await locator.nth(index).fill(input, { timeout: 5000 });
    if (action.submit) {
      await locator.nth(index).press("Enter", { timeout: 5000 });
      return `✅ Typed "${input}" into "${text}" and pressed Enter.`;
    }
    return `✅ Typed "${input}" into "${text}".`;
  } catch (e) {
    return `❌ Failed to type into "${text}": ${(e as Error).message}.`;
  }
}

async function doScroll(page: Page, action: Action): Promise<string> {
  const direction = action.direction as string | undefined;
  if (!direction || !["up", "down"].includes(direction)) {
    return `❌ "scroll" requires a "direction" field: "up" or "down".\n  Example: {"action": "scroll", "direction": "down"}`;
  }
  const delta = direction === "down" ? 600 : -600;
  await page.mouse.wheel(0, delta);
  return `✅ Scrolled ${direction}.`;
}

async function doGoto(page: Page, action: Action): Promise<string> {
  const url = action.url as string | undefined;
  if (!url) {
    return `❌ "goto" requires a "url" field.\n  Example: {"action": "goto", "url": "https://example.com"}`;
  }
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    return `✅ Navigated to ${url}.`;
  } catch (e) {
    return `❌ Failed to navigate to "${url}": ${(e as Error).message}.`;
  }
}

async function doBack(page: Page): Promise<string> {
  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });
    return `✅ Went back.`;
  } catch (e) {
    return `❌ Failed to go back: ${(e as Error).message}.`;
  }
}

async function doWait(action: Action): Promise<string> {
  const raw = Number(action.seconds);
  if (isNaN(raw)) {
    return `❌ "wait" requires a numeric "seconds" field.\n  Example: {"action": "wait", "seconds": 3}`;
  }
  const seconds = Math.min(Math.max(raw, 0.5), 10);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  return `✅ Waited ${seconds} second(s).`;
}

function doDone(action: Action): string {
  const summary = (action.summary as string) ?? "(no summary provided)";
  return `🏁 DONE. Summary: ${summary}`;
}

function doHelp(action: Action): string {
  const topic = action.topic as string | undefined;
  if (topic) {
    const help = ACTION_HELP[topic];
    if (!help) {
      return `❌ Unknown action "${topic}". Available actions: ${AVAILABLE_ACTIONS.join(", ")}`;
    }
    return `ℹ️ **${topic}**:\n${help}`;
  }
  let msg = `ℹ️ **Available actions**:\n`;
  for (const [name, help] of Object.entries(ACTION_HELP)) {
    msg += `- **${name}**: ${help.split("\n")[0]}\n`;
  }
  return msg;
}

// ─── Parse model response ───────────────────────────────────────────────────

function parseAction(raw: string): Action | string {
  // Try to extract JSON from the response (the model may include extra text)
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    return `❌ Could not find a JSON action in your response. Please respond with a JSON object, e.g.:\n  {"action": "click", "text": "Log in"}\n\nAvailable actions: ${AVAILABLE_ACTIONS.join(", ")}`;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.action || typeof parsed.action !== "string") {
      return `❌ Your JSON is missing the "action" field. Example: {"action": "click", "text": "Log in"}`;
    }
    return parsed as Action;
  } catch {
    return `❌ Invalid JSON: ${jsonMatch[0]}. Please double-check your syntax.`;
  }
}

// ─── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(objective: string): string {
  return `You are a web browsing agent. You interact with web pages by responding with a single JSON action per turn.

## Your objective
${objective}

## How it works
1. Each turn you receive a screenshot and a description of the current page state (URL, title, interactive elements, visible text).
2. You respond with exactly ONE JSON action. Do not include any other text—just the JSON.
3. You will then be told the result and shown the updated page.

## Available actions
${Object.entries(ACTION_HELP)
  .map(([name, help]) => `### ${name}\n${help}`)
  .join("\n\n")}

## Rules
- Respond with only a JSON object each turn. No commentary, no markdown fences.
- Use the interactive elements list and visible text to identify what to click or type.
- If you need to pick from multiple matches, specify "index".
- When you have accomplished the objective, use the "done" action with a summary.
- If you are stuck, try scrolling, waiting, or using "help".
`;
}

// ─── Markdown Log ───────────────────────────────────────────────────────────

class MarkdownLog {
  private lines: string[] = [];
  private filepath: string;

  constructor(filepath: string) {
    this.filepath = filepath;
    this.lines.push("# Agent Run Log\n");
  }

  addMeta(key: string, value: string) {
    this.lines.push(`- **${key}**: ${value}`);
  }

  addSection(title: string) {
    this.lines.push(`\n---\n\n## ${title}\n`);
  }

  addText(text: string) {
    this.lines.push(text);
  }

  addScreenshot(relPath: string, caption: string) {
    this.lines.push(`\n![${caption}](${relPath})\n`);
  }

  async save() {
    await Deno.writeTextFile(this.filepath, this.lines.join("\n"));
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Read objective
  const objectivePath = path.resolve(OBJECTIVE_FILE);
  const objective = await Deno.readTextFile(objectivePath);
  console.log(`📋 Objective loaded from ${objectivePath}`);

  // Create run directory
  const timestamp = new Date().toISOString().replace(/[:.TZ]/g, "-").replace(/-$/, "");
  const runDir = path.join("runs", timestamp);
  await Deno.mkdir(runDir, { recursive: true });

  // Init log
  const log = new MarkdownLog(path.join(runDir, "log.md"));
  log.addMeta("Model", MODEL);
  log.addMeta("Objective file", OBJECTIVE_FILE);
  log.addMeta("Started", new Date().toISOString());
  log.addText(`\n### Objective\n\n${objective}`);

  // Launch browser
  console.log("🌐 Launching browser...");
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page: Page = await context.newPage();
  await page.goto("about:blank");

  // Build conversation
  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystemPrompt(objective) },
  ];

  let done = false;

  for (let turn = 1; turn <= MAX_TURNS && !done; turn++) {
    console.log(`\n═══ Turn ${turn}/${MAX_TURNS} ═══`);
    log.addSection(`Turn ${turn}`);

    // Screenshot + page state
    const screenshotPath = await takeScreenshot(page, runDir, turn);
    const screenshotB64 = await screenshotToBase64(screenshotPath);
    const pageState = await getPageState(page);
    const relScreenshot = path.basename(screenshotPath);

    log.addScreenshot(relScreenshot, `Turn ${turn} screenshot`);
    log.addText("### Page state\n\n" + pageState);

    console.log(`  URL: ${page.url()}`);

    // Send page state + screenshot to model
    messages.push({
      role: "user",
      content: pageState + "\n\nRespond with your next action as a JSON object.",
      images: [screenshotB64],
    });

    // Get model response
    console.log("  🤖 Asking model...");
    let response: string;
    try {
      response = await chatOllama(messages);
    } catch (e) {
      console.error(`  ❌ Ollama error: ${(e as Error).message}`);
      log.addText(`\n**Ollama error**: ${(e as Error).message}\n`);
      break;
    }

    console.log(`  Model: ${response.slice(0, 200)}`);
    messages.push({ role: "assistant", content: response });
    log.addText(`### Model response\n\n\`\`\`json\n${response}\n\`\`\`\n`);

    // Parse action
    const actionOrError = parseAction(response);
    if (typeof actionOrError === "string") {
      // Parse error — inform the model
      console.log(`  ${actionOrError.slice(0, 120)}`);
      log.addText(`### Result\n\n${actionOrError}\n`);
      messages.push({ role: "user", content: actionOrError });
      continue;
    }

    const action = actionOrError;
    console.log(`  Action: ${JSON.stringify(action)}`);

    // Execute action
    const result = await executeAction(page, action);
    console.log(`  Result: ${result.slice(0, 120)}`);
    log.addText(`### Result\n\n${result}\n`);

    if (action.action === "done") {
      done = true;
      break;
    }

    // Pause briefly to let the page settle
    await new Promise((r) => setTimeout(r, ACTION_DELAY_MS));

    // Report result back to model (page state comes next turn via screenshot)
    const newUrl = page.url();
    messages.push({
      role: "user",
      content: `${result}\n\nThe page URL is now: ${newUrl}\n\nI will show you the updated page state and screenshot next.`,
    });
  }

  if (!done) {
    console.log("\n⏱️ Reached maximum turns without completing the objective.");
    log.addText("\n---\n\n**Reached maximum turns without completing the objective.**\n");
  }

  // Final screenshot
  const finalScreenshot = await takeScreenshot(page, runDir, MAX_TURNS + 1);
  log.addScreenshot(path.basename(finalScreenshot), "Final screenshot");

  log.addMeta("Ended", new Date().toISOString());
  await log.save();
  console.log(`\n📝 Log saved to ${path.join(runDir, "log.md")}`);

  await browser.close();
  console.log("✅ Browser closed. Done.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  Deno.exit(1);
});
