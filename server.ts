import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WASI } from "node:wasi";
import { env } from "node:process";

const QJS_WASM_PATH = new URL("./qjs-wasi.wasm", import.meta.url);
const TOOL_NAME = "run_javascript_code";

async function loadAndCompileWasm() {
  try {
    const wasmBuffer = await readFile(QJS_WASM_PATH);
    const compiledWasmModule = await WebAssembly.compile(wasmBuffer);
    return compiledWasmModule;
  } catch (error) {
    process.exit(1);
  }
}

async function runQuickJsInSandbox(
  jsCode: string,
  compiledWasm: WebAssembly.Module,
): Promise<{ stdout: string; stderr: string; error?: string }> {
  let tempDir: string | undefined;
  let stdoutHandle: Awaited<ReturnType<typeof open>> | undefined;
  let stderrHandle: Awaited<ReturnType<typeof open>> | undefined;
  let stdoutPath: string | undefined;
  let stderrPath: string | undefined;

  try {
    tempDir = await mkdtemp(join(tmpdir(), "quickjs-wasi-"));
    stdoutPath = join(tempDir, "stdout.log");
    stderrPath = join(tempDir, "stderr.log");

    stdoutHandle = await open(stdoutPath, "w");
    stderrHandle = await open(stderrPath, "w");
    const stdoutFd = stdoutHandle.fd;
    const stderrFd = stderrHandle.fd;

    const wasi = new WASI({
      version: "preview1",
      args: ["qjs", "-e", jsCode],
      env,
      stdin: 0,
      stdout: stdoutFd,
      stderr: stderrFd,
      returnOnExit: true,
    });

    const instance = await WebAssembly.instantiate(
      compiledWasm,
      wasi.getImportObject() as WebAssembly.Imports,
    );

    let exitCode = 0;
    try {
      exitCode = wasi.start(instance);
    } catch (wasiError: any) {
      return {
        stdout: "",
        stderr: `WASI start error: ${wasiError.message ?? wasiError}`,
        error: `Sandbox execution failed during start: ${
          wasiError.message ?? wasiError
        }`,
      };
    }

    await stdoutHandle.close();
    stdoutHandle = undefined;
    await stderrHandle.close();
    stderrHandle = undefined;

    const capturedStdout = await readFile(stdoutPath, "utf8");
    const capturedStderr = await readFile(stderrPath, "utf8");

    let executionError: string | undefined = undefined;
    if (exitCode !== 0) {
      executionError =
        `QuickJS process exited with code ${exitCode}. Check stderr for details.`;
    }

    return {
      stdout: capturedStdout,
      stderr: capturedStderr,
      error: executionError,
    };
  } catch (err: any) {
    return {
      stdout: "",
      stderr: "",
      error: `Sandbox setup or execution failed: ${err.message}`,
    };
  } finally {
    try {
      if (stdoutHandle) await stdoutHandle.close();
      if (stderrHandle) await stderrHandle.close();
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
    }
  }
}

async function startServer() {
  const compiledWasmModule = await loadAndCompileWasm();
  if (!compiledWasmModule) {
    process.exit(1);
  }

  const server = new McpServer({
    name: "MCP QuickJS Runner",
    version: "1.0.0",
    description:
      "An MCP server that provides a tool to execute JavaScript code in a QuickJS WASM sandbox.",
  });

  server.tool(
    TOOL_NAME,
    `Executes the provided JavaScript code in a secure WASM sandbox (QuickJS). Returns stdout and stderr. Non-zero exit code indicates an error.`,
    {
      javascript_code: z.string().describe(
        "The JavaScript code to execute in the sandbox.",
      ),
    },
    async ({ javascript_code }) => {
      try {
        const result = await runQuickJsInSandbox(
          javascript_code,
          compiledWasmModule,
        );

        let combinedOutput = "";
        if (result.stdout) {
          combinedOutput += `--- stdout ---\n${result.stdout}\n--- stdout ---\n`;
        }
        if (result.stderr) {
          combinedOutput += `--- stderr ---\n${result.stderr}\n--- stderr ---\n`;
        }
        if (result.error) {
          combinedOutput += `--- Execution Error ---\n${result.error}\n--- Execution Error ---\n`;
        }
        if (!result.stdout && !result.stderr && !result.error) {
          combinedOutput = "--- Execution Success (No Output, Exit Code 0) ---";
        }

        const isError = !!result.error ||
          (result.stderr && result.stderr.trim().length > 0);

        return {
          content: [{
            type: "text",
            text: combinedOutput.trim(),
          }],
          isError: Boolean(isError),
        };
      } catch (toolError: any) {
        return {
          content: [{
            type: "text",
            text: `Server error during tool execution: ${toolError.message}`,
          }],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startServer().catch((err) => {
  process.exit(1);
});
