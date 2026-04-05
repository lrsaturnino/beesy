import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Helper to resolve paths relative to project root
function projectPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, ...segments);
}

// Helper to read and parse JSON files
function readJson(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

// Helper to read file as text
function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

// -------------------------------------------------------------------
// Group 1: Project Configuration
// -------------------------------------------------------------------
describe("project configuration", () => {
  it("package.json has ESM type", () => {
    const pkg = readJson(projectPath("package.json"));
    expect(pkg.type).toBe("module");
  });

  it("package.json has required scripts", () => {
    const pkg = readJson(projectPath("package.json"));
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts).toBeDefined();
    expect(scripts.build).toBeDefined();
    expect(scripts.build).toBeTypeOf("string");
    expect(scripts.test).toBeDefined();
    expect(scripts.test).toBeTypeOf("string");
    expect(scripts.dev).toBeDefined();
    expect(scripts.dev).toBeTypeOf("string");
    expect(scripts["type-check"]).toBeDefined();
    expect(scripts["type-check"]).toBeTypeOf("string");
  });

  it("package.json has runtime dependencies", () => {
    const pkg = readJson(projectPath("package.json"));
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps).toBeDefined();
    expect(deps["@slack/bolt"]).toBeDefined();
    expect(deps["bullmq"]).toBeDefined();
    expect(deps["ioredis"]).toBeDefined();
    expect(deps["yaml"]).toBeDefined();
    expect(deps["better-sqlite3"]).toBeDefined();
  });

  it("package.json has dev dependencies", () => {
    const pkg = readJson(projectPath("package.json"));
    const devDeps = pkg.devDependencies as Record<string, string>;
    expect(devDeps).toBeDefined();
    expect(devDeps["typescript"]).toBeDefined();
    expect(devDeps["vitest"]).toBeDefined();
    expect(devDeps["@types/node"]).toBeDefined();
    expect(devDeps["@types/better-sqlite3"]).toBeDefined();
    expect(devDeps["tsx"]).toBeDefined();
  });
});

// -------------------------------------------------------------------
// Group 2: TypeScript Configuration
// -------------------------------------------------------------------
describe("typescript configuration", () => {
  it("tsconfig.json targets NodeNext module resolution", () => {
    const tsconfig = readJson(projectPath("tsconfig.json"));
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions).toBeDefined();
    expect(compilerOptions.module).toBe("NodeNext");
    expect(compilerOptions.moduleResolution).toBe("NodeNext");
  });

  it("tsconfig.json enables strict mode", () => {
    const tsconfig = readJson(projectPath("tsconfig.json"));
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions).toBeDefined();
    expect(compilerOptions.strict).toBe(true);
  });

  it("tsconfig.json targets ES2022", () => {
    const tsconfig = readJson(projectPath("tsconfig.json"));
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions).toBeDefined();
    expect(compilerOptions.target).toBe("ES2022");
  });

  it("tsconfig.json has correct directory configuration", () => {
    const tsconfig = readJson(projectPath("tsconfig.json"));
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions).toBeDefined();
    expect(compilerOptions.outDir).toBe("./dist");
    expect(compilerOptions.rootDir).toBe("./src");

    const include = tsconfig.include as string[];
    expect(include).toBeDefined();
    expect(include).toContain("src/**/*");
  });
});

// -------------------------------------------------------------------
// Group 3: Docker Compose Configuration
// -------------------------------------------------------------------
describe("docker compose configuration", () => {
  it("docker-compose.yml defines Redis service", () => {
    const content = readText(projectPath("docker-compose.yml"));
    const compose = parseYaml(content) as Record<string, unknown>;
    const services = compose.services as Record<string, Record<string, unknown>>;
    expect(services).toBeDefined();
    expect(services.redis).toBeDefined();
    const image = services.redis.image as string;
    expect(image).toBeDefined();
    expect(image.startsWith("redis:7")).toBe(true);
  });

  it("docker-compose.yml maps Redis port 6379", () => {
    const content = readText(projectPath("docker-compose.yml"));
    const compose = parseYaml(content) as Record<string, unknown>;
    const services = compose.services as Record<string, Record<string, unknown>>;
    expect(services).toBeDefined();
    expect(services.redis).toBeDefined();
    const ports = services.redis.ports as string[];
    expect(ports).toBeDefined();
    const portMapping = ports.join(",");
    expect(portMapping).toContain("6379");
  });
});

// -------------------------------------------------------------------
// Group 4: Environment Template
// -------------------------------------------------------------------
describe("environment template", () => {
  it(".env.example contains all required variables", () => {
    const content = readText(projectPath(".env.example"));
    expect(content).toContain("SLACK_BOT_TOKEN");
    expect(content).toContain("SLACK_APP_TOKEN");
    expect(content).toContain("SLACK_SIGNING_SECRET");
    expect(content).toContain("REDIS_URL");
    expect(content).toContain("GITHUB_TOKEN");
    expect(content).toContain("LOG_LEVEL");
  });
});

// -------------------------------------------------------------------
// Group 5: Directory Structure
// -------------------------------------------------------------------
describe("directory structure", () => {
  it("all required source directories exist", () => {
    const srcDirs = [
      "src/adapters",
      "src/gates",
      "src/queue",
      "src/executor",
      "src/runners",
      "src/persistence",
      "src/utils",
    ];

    for (const dir of srcDirs) {
      const fullPath = projectPath(dir);
      expect(
        fs.existsSync(fullPath),
        `expected directory to exist: ${dir}`,
      ).toBe(true);
      const stat = fs.statSync(fullPath);
      expect(stat.isDirectory(), `expected ${dir} to be a directory`).toBe(
        true,
      );
    }
  });

  it("all required top-level directories exist", () => {
    const topDirs = ["scripts", "gates", "skills", "tests"];

    for (const dir of topDirs) {
      const fullPath = projectPath(dir);
      expect(
        fs.existsSync(fullPath),
        `expected directory to exist: ${dir}`,
      ).toBe(true);
      const stat = fs.statSync(fullPath);
      expect(stat.isDirectory(), `expected ${dir} to be a directory`).toBe(
        true,
      );
    }
  });
});

// -------------------------------------------------------------------
// Group 6: Utility Modules
// -------------------------------------------------------------------
describe("utility modules", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("config module loads environment variables", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-test-token");
    vi.stubEnv("SLACK_SIGNING_SECRET", "test-signing-secret");
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token");
    vi.stubEnv("REDIS_URL", "redis://custom:6380");
    vi.stubEnv("LOG_LEVEL", "debug");

    const { loadConfig } = await import("../src/utils/config.js");
    const config = loadConfig();

    expect(config.slackBotToken).toBe("xoxb-test-token");
    expect(config.slackAppToken).toBe("xapp-test-token");
    expect(config.slackSigningSecret).toBe("test-signing-secret");
    expect(config.githubToken).toBe("ghp_test_token");
    expect(config.redisUrl).toBe("redis://custom:6380");
    expect(config.logLevel).toBe("debug");
  });

  it("config module applies defaults for optional variables", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-test-token");
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token");

    // Remove optional vars to test defaults
    delete process.env.LOG_LEVEL;
    delete process.env.REDIS_URL;
    delete process.env.SLACK_SIGNING_SECRET;

    const { loadConfig } = await import("../src/utils/config.js");
    const config = loadConfig();

    expect(config.logLevel).toBe("info");
    expect(config.redisUrl).toBe("redis://localhost:6379");
  });

  it("config module throws on missing required variables", async () => {
    // Clear all required env vars
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.REDIS_URL;
    delete process.env.LOG_LEVEL;

    const { loadConfig } = await import("../src/utils/config.js");

    expect(() => loadConfig()).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("logger respects LOG_LEVEL hierarchy", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { createLogger } = await import("../src/utils/logger.js");
    const logger = createLogger("warn");

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    // debug and info should be silenced when level is warn
    // Only warn and error should produce output
    const totalCalls = consoleSpy.mock.calls.length + consoleErrorSpy.mock.calls.length;
    expect(totalCalls).toBe(2);
  });

  it("logger outputs structured format", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { createLogger } = await import("../src/utils/logger.js");
    const logger = createLogger("info");

    logger.info("test message");

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toBeDefined();
    expect(output).toContain("INFO");
    expect(output).toContain("test message");
  });
});

// -------------------------------------------------------------------
// Group 7: Git Configuration
// -------------------------------------------------------------------
describe("git configuration", () => {
  it(".gitignore excludes required paths", () => {
    const content = readText(projectPath(".gitignore"));
    expect(content).toContain("node_modules");
    expect(content).toContain("dist");
    expect(content).toContain(".env");
    expect(content).toContain("coverage");
  });
});
