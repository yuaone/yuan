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
export type Provider = "openai" | "anthropic" | "yua" | "google";

/** YUAN CLI configuration (stored in ~/.yuan/config.json) */
export interface YuanConfig {
  provider: Provider;
  apiKey: string;
  /** Multi-provider key storage — keys per provider */
  apiKeys?: Partial<Record<Provider, string>>;
  model?: string;
  baseUrl?: string;
  theme: "dark" | "light";
  mode: "local" | "cloud";
  serverUrl: string;
}

const YUAN_DIR = path.join(os.homedir(), ".yuan");
const CONFIG_PATH = path.join(YUAN_DIR, "config.json");

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
  yua: "yua-normal",
  google: "gemini-2.5-flash",
};

/** Default configuration */
function defaultConfig(): YuanConfig {
  return {
    provider: "yua",
    apiKey: "",
    model: undefined,
    baseUrl: undefined,
    theme: "dark",
    mode: "local",
    serverUrl: "https://api.yuaone.com",
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
    if (this.config.mode === "cloud") {
      return this.config.apiKey.startsWith("yua_sk_") && this.config.apiKey.length > 7;
    }
    return this.config.apiKey.length > 0;
  }

  /** Get the effective model name (user override or provider default) */
  getModel(): string {
    return this.config.model ?? DEFAULT_MODELS[this.config.provider];
  }

  /** Set API key for a provider (also stores in multi-key map) */
  setKey(provider: Provider, apiKey: string): void {
    this.config.provider = provider;
    this.config.apiKey = apiKey;
    if (!this.config.apiKeys) this.config.apiKeys = {};
    this.config.apiKeys[provider] = apiKey;
    this.save();
  }

  /** Set API key for a specific provider without changing active provider */
  setProviderKey(provider: Provider, apiKey: string): void {
    if (!this.config.apiKeys) this.config.apiKeys = {};
    this.config.apiKeys[provider] = apiKey;
    this.save();
  }

  /**
   * Get the effective API key for a given provider.
   * Priority: config apiKeys map → environment variables → legacy apiKey (if provider matches)
   */
  getKey(provider: Provider): string {
    // 1. Multi-key config map
    const fromMap = this.config.apiKeys?.[provider];
    if (fromMap) return fromMap;

    // 2. Environment variables
    const envMap: Record<Provider, string> = {
      openai: process.env["OPENAI_API_KEY"] ?? "",
      anthropic: process.env["ANTHROPIC_API_KEY"] ?? "",
      google: process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "",
      yua: process.env["YUA_API_KEY"] ?? "",
    };
    if (envMap[provider]) return envMap[provider];

    // 3. Legacy single-key fallback (if provider matches)
    if (this.config.provider === provider && this.config.apiKey) return this.config.apiKey;

    return "";
  }

  /**
   * Returns all providers that have a configured API key
   * (config map + environment variables).
   */
  getAvailableProviders(): Provider[] {
    const all: Provider[] = ["openai", "anthropic", "google", "yua"];
    return all.filter((p) => this.getKey(p).length > 0);
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

  /** Set execution mode (local or cloud) */
  setMode(mode: "local" | "cloud"): void {
    this.config.mode = mode;
    this.save();
  }

  /** Set cloud server URL */
  setServerUrl(url: string): void {
    this.config.serverUrl = url;
    this.save();
  }

  /** Check if running in cloud mode */
  isCloudMode(): boolean {
    return this.config.mode === "cloud";
  }

  /** Get the effective server URL */
  getServerUrl(): string {
    return this.config.serverUrl;
  }

  /** Display current config (masking API key) */
  show(): string {
    const c = this.config;
    const maskKey = (k: string) =>
      k ? k.slice(0, 6) + "..." + k.slice(-4) : "(not set)";

    const allProviders: Provider[] = ["openai", "anthropic", "google", "yua"];
    const keyLines = allProviders.map((p) => {
      const key = this.getKey(p);
      const active = p === c.provider ? " ← active" : "";
      const source = c.apiKeys?.[p] ? "config" : (key ? "env" : "");
      return `  ${p.padEnd(10)}: ${maskKey(key)}${source ? ` (${source})` : ""}${active}`;
    });

    const lines = [
      `Mode     : ${c.mode}`,
      `Model    : ${this.getModel()}`,
      `Base URL : ${c.baseUrl ?? "(default)"}`,
      `Server   : ${c.mode === "cloud" ? c.serverUrl : "(n/a)"}`,
      `Theme    : ${c.theme}`,
      `Config   : ${CONFIG_PATH}`,
      ``,
      `API Keys:`,
      ...keyLines,
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
    console.log("    1) YUA (recommended, self-hosted)");
    console.log("    2) OpenAI");
    console.log("    3) Anthropic");
    console.log("    4) Google Gemini");
    const providerChoice = await ask("\n  Provider [1-3] (default: 1): ");
    const providerMap: Record<string, Provider> = {
      "1": "yua",
      "2": "openai",
      "3": "anthropic",
       "4": "google",
    };
    const provider = providerMap[providerChoice] ?? "yua";
    this.config.provider = provider;

    // Execution mode selection
    console.log("\n  Execution mode:");
    console.log("    1) Local (BYOK — runs on your machine)");
    console.log("    2) Cloud (YUA Platform — runs on server)");
    const modeChoice = await ask("\n  Mode [1-2] (default: 1): ");
    const isCloud = modeChoice === "2";
    this.config.mode = isCloud ? "cloud" : "local";

    if (isCloud) {
      // Cloud mode — override provider to yua
      this.config.provider = "yua";

      // Server URL
      const serverUrl = await ask(`  Server URL (default: ${defaultConfig().serverUrl}): `);
      if (serverUrl) {
        this.config.serverUrl = serverUrl;
      } else {
        this.config.serverUrl = defaultConfig().serverUrl;
      }

      // YUA platform API key
      const yuaKey = await ask("  YUA API key (yua_sk_xxx): ");
      if (yuaKey) {
        this.config.apiKey = yuaKey;
      }
    } else {
      // Local mode — ask for provider API key
      const keyPrompt = `  ${provider} API key: `;
      const apiKey = await ask(keyPrompt);
      if (apiKey) {
        this.config.apiKey = apiKey;
      }
    }

    // Model (optional)
    const effectiveProvider = this.config.provider;
    const modelPrompt = `  Model (default: ${DEFAULT_MODELS[effectiveProvider]}): `;
    const model = await ask(modelPrompt);
    if (model) {
      this.config.model = model;
    }

    // Base URL (optional, only relevant for local mode)
    if (!isCloud) {
      const baseUrl = await ask("  Custom base URL (optional): ");
      if (baseUrl) {
        this.config.baseUrl = baseUrl;
      }
    }

    this.save();
    rl.close();

    console.log("\n  Configuration saved to " + CONFIG_PATH);
  }
}
