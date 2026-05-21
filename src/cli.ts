// Entry point for the Jira Triage CLI
import type { Config } from "./types.ts";
import { runFetch } from "./commands/fetch.ts";
import { runProcess } from "./commands/process.ts";
import { runServe } from "./commands/serve.ts";

// Simple args parser (avoids external dependency)
type ParsedArgs = {
  _: string[];
  config: string;
  "retry-errors": boolean;
  "test-data": boolean;
  help: boolean;
  key: string | null;
};

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    _: [],
    config: "./config.json",
    "retry-errors": false,
    "test-data": false,
    help: false,
    key: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--retry-errors") {
      result["retry-errors"] = true;
    } else if (arg === "--test-data") {
      result["test-data"] = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--config" && i + 1 < args.length) {
      result.config = args[++i];
    } else if (arg === "--key" && i + 1 < args.length) {
      result.key = args[++i];
    } else if (!arg.startsWith("--")) {
      result._.push(arg);
    }
  }
  return result;
}

async function loadConfig(configPath: string): Promise<Config> {
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Error: Could not read config file: ${configPath}`);
    Deno.exit(1);
  }

  let config: Config;
  try {
    config = JSON.parse(text) as Config;
  } catch {
    console.error(`Error: Config file is not valid JSON: ${configPath}`);
    Deno.exit(1);
  }

  // Validate required fields
  const missing: string[] = [];
  if (!config.jira?.baseUrl) missing.push("jira.baseUrl");
  if (!config.jira?.project) missing.push("jira.project");
  if (!config.ai?.endpoint) missing.push("ai.endpoint");
  if (!config.ai?.model) missing.push("ai.model");
  if (!config.data?.dir) missing.push("data.dir");
  if (!config.server?.port) missing.push("server.port");

  if (missing.length > 0) {
    console.error(`Error: Config is missing required fields: ${missing.join(", ")}`);
    Deno.exit(1);
  }

  return config;
}

function printUsage(): void {
  console.log(`Usage: deno task triage <command> [flags]

Commands:
  fetch      Fetch all issues from Jira and save raw data to disk
  process    Run AI analysis on all open issues that need it
  serve      Start the local web UI server

Flags (all commands):
  --config <path>   Path to config file (default: ./config.json)

Flags (fetch):
  (none)

Flags (process):
  --retry-errors    Reprocess issues with status "error"
  --key <KEY>       Reprocess a single specific issue

Flags (serve):
  --test-data       Use ./test-data/ directory instead of configured data dir
`);
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);

  const command = args._[0] as string | undefined;

  if (!command || args.help) {
    printUsage();
    Deno.exit(command ? 0 : 1);
  }

  const config = await loadConfig(args.config);

  switch (command) {
    case "fetch":
      await runFetch(config);
      break;

    case "process":
      await runProcess(
        config,
        args["retry-errors"],
        args.key,
      );
      break;

    case "serve":
      await runServe(config, args["test-data"]);
      break;

    default:
      console.error(`Error: Unknown command: ${command}`);
      printUsage();
      Deno.exit(1);
  }
}

main();
