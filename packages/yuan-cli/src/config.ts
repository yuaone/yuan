/**
 * YUAN CLI — Configuration Manager
 *
 * Manages BYOK API key storage and CLI settings.
 * Config file: ~/.yuan/config.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

/** Supported LLM providers */
export type Provider = "openai" | "anthropic" | "google" | "yua" | "deepseek";

/** YUAN CLI configuration (stored in ~/.yuan/config.json) */
export interface YuanConfig {
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  theme: "dark" | "light";
}

const YUAN_DIR = path.join(os.homedir(), ".yuan");
const CONFIG_PATH = path.join(YUAN_DIR, "config.json");

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.5-flash",
  yua: "yua-pro",
  deepseek: "deepseek-chat",
};

/** Default configuration */
function defaultConfig(): YuanConfig {
  return {
    provider: "anthropic",
    apiKey: "",
    model: undefined,
    baseUrl: undefined,
    theme: "dark",
  };
}

/**
 * ConfigManager — handles reading/writing ~/.yuan/config.json
 */
export class ConfigManager {
  private config: YuanConfig;

  constructor() {
    this.config = this.load();
  }

  /** Load config from disk, falling back to defaults */
  private load(): YuanConfig {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw) as Partial<YuanConfig>;
        return { ...defaultConfig(), ...parsed };
      }
    } catch {
      // Corrupted config — use defaults
    }
    return defaultConfig();
  }

  /** Save current config to disk */
  private save(): void {
    if (!fs.existsSync(YUAN_DIR)) {
      fs.mkdirSync(YUAN_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), { encoding: "utf-8", mode: 0o600 });
  }

  /** Get current config */
  get(): YuanConfig {
    return { ...this.config };
  }

  /** Check if API key is configured */
  isConfigured(): boolean {
    return this.config.apiKey.length > 0;
  }

  /** Get the effective model name (user override or provider default) */
  getModel(): string {
    return this.config.model ?? DEFAULT_MODELS[this.config.provider];
  }

  /** Set API key for a provider */
  setKey(provider: Provider, apiKey: string): void {
    this.config.provider = provider;
    this.config.apiKey = apiKey;
    this.save();
  }

  /** Set model override */
  setModel(model: string): void {
    this.config.model = model;
    this.save();
  }

  /** Set base URL override (e.g. for Azure OpenAI) */
  setBaseUrl(baseUrl: string | undefined): void {
    this.config.baseUrl = baseUrl;
    this.save();
  }

  /** Set theme */
  setTheme(theme: "dark" | "light"): void {
    this.config.theme = theme;
    this.save();
  }

  /** Display current config (masking API key) */
  show(): string {
    const c = this.config;
    const maskedKey = c.apiKey
      ? c.apiKey.slice(0, 6) + "..." + c.apiKey.slice(-4)
      : "(not set)";

    const lines = [
      `Provider : ${c.provider}`,
      `API Key  : ${maskedKey}`,
      `Model    : ${this.getModel()}`,
      `Base URL : ${c.baseUrl ?? "(default)"}`,
      `Theme    : ${c.theme}`,
      `Config   : ${CONFIG_PATH}`,
    ];
    return lines.join("\n");
  }

  /**
   * Interactive setup prompt using readline.
   * Walks the user through provider selection and API key entry.
   */
  async interactiveSetup(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> =>
      new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
      });

    console.log("\n  YUAN Configuration\n");

    // Provider selection
    console.log("  Select LLM provider:");
    console.log("    1) OpenAI");
    console.log("    2) Anthropic");
    console.log("    3) Google (Gemini)");
    console.log("    4) YUA");
    console.log("    5) DeepSeek");
    const providerChoice = await ask("\n  Provider [1-5] (default: 2): ");
    const providerMap: Record<string, Provider> = {
      "1": "openai",
      "2": "anthropic",
      "3": "google",
      "4": "yua",
      "5": "deepseek",
    };
    const provider = providerMap[providerChoice] ?? "anthropic";
    this.config.provider = provider;

    // API key
    const keyPrompt = `  ${provider} API key: `;
    const apiKey = await ask(keyPrompt);
    if (apiKey) {
      this.config.apiKey = apiKey;
    }

    // Model (optional)
    const modelPrompt = `  Model (default: ${DEFAULT_MODELS[provider]}): `;
    const model = await ask(modelPrompt);
    if (model) {
      this.config.model = model;
    }

    // Base URL (optional)
    const baseUrl = await ask("  Custom base URL (optional): ");
    if (baseUrl) {
      this.config.baseUrl = baseUrl;
    }

    this.save();
    rl.close();

    console.log("\n  Configuration saved to " + CONFIG_PATH);
  }
}
