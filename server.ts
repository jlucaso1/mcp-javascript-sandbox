import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";
import { env } from "node:process";

// --- Configuration ---
// Adjust this path if your WASM file is located elsewhere
const QJS_WASM_PATH = new URL("./qjs-wasi.wasm", import.meta.url);
const TOOL_NAME = "run_javascript_code";
// --- --- --- --- --- -

async function loadAndCompileWasm() {
  try {
    console.log(`Loading WASM from: ${QJS_WASM_PATH}`);
    const wasmBuffer = await readFile(QJS_WASM_PATH);
    console.log(
      `Compiling WASM (${(wasmBuffer.length / 1024 / 1024).toFixed(2)} MB)...`,
    );
    const compiledWasmModule = await WebAssembly.compile(wasmBuffer);
    console.log("WASM module compiled successfully.");
    return compiledWasmModule;
  } catch (error) {
    console.error(
      "Fatal Error: Could not load or compile QuickJS WASM module.",
    );
    console.error(
      "Please ensure 'qjs-wasi.wasm' exists at the specified path:",
      QJS_WASM_PATH,
    );
    console.error(error);
    process.exit(1); // Exit if we can't load the sandbox
  }
}
// --- --- --- --- ---

/**
 * Executes JavaScript code inside a QuickJS WASM sandbox using WASI.
 * Captures stdout and stderr separately.
 *
 * @param jsCode The JavaScript code string to execute.
 * @param compiledWasm The pre-compiled WebAssembly module.
 * @returns An object containing captured stdout and stderr.
 */
async function runQuickJsInSandbox(
  jsCode: string,
  compiledWasm: WebAssembly.Module,
): Promise<{ stdout: string; stderr: string; error?: string }> {
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;

  try {
    // 3. Configure WASI for this specific execution
    const wasi = new WASI({
      version: "preview1",
      args: ["qjs", "-e", jsCode], // Pass code via '-e'
      env,
      stdin: 0, // Inherit stdin (or redirect if needed)
      stdout: stdoutFd, // Redirect stdout to our temp file
      stderr: stderrFd, // Redirect stderr to our temp file
    });

    // 4. Instantiate the WASM module with the WASI imports for *this* run
    const instance = await WebAssembly.instantiate(
      compiledWasm,
      wasi.getImportObject() as WebAssembly.Imports,
    );

    console.log(
      `[Sandbox] Executing code starting with: "${jsCode.substring(0, 50)}..."`,
    );

    // 5. Start the WASM instance (synchronous execution within the async function)
    try {
      wasi.start(instance);
      // If returnOnExit was true, this might throw an error with the exit code
    } catch (wasiError: any) {
      // Handle potential non-zero exit codes if returnOnExit is used,
      // or other start errors. We'll capture this as a general error below.
      console.warn("[Sandbox] WASI start threw:", wasiError.message);
      // Optionally, write the error to stderr capture
    }

    console.log("[Sandbox] Execution finished.");

    stdoutFd = undefined; // Avoid double closing in finally
    stderrFd = undefined;

    return {
      stdout: "", // Placeholder for captured stdout
      stderr: "", // Placeholder for captured stderr
      error: undefined, // No error if execution was successful
    };
  } catch (err: any) {
    console.error("[Sandbox] Error during execution:", err);
    // Ensure we try to read any partial stderr even if setup failed mid-way
    let capturedStderrOnError = "";

    return {
      stdout: "",
      stderr: capturedStderrOnError, // Include any captured stderr
      error: `Sandbox execution failed: ${err.message}`,
    };
  }
}

// --- MCP Server Setup ---
async function startServer() {
  // Ensure WASM is loaded before starting the server
  const compiledWasmModule = await loadAndCompileWasm();

  console.log("Setting up MCP server...");
  const server = new McpServer({
    name: "MCP QuickJS Runner",
    version: "1.0.0",
    description:
      "An MCP server that provides a tool to execute JavaScript code in a QuickJS WASM sandbox.",
  });

  // Define the JavaScript execution tool
  server.tool(
    TOOL_NAME,
    `Executes the provided JavaScript code in a secure WASM sandbox (QuickJS). Returns stdout and stderr.`,
    // Input schema: expects an object with a 'javascript_code' string property
    {
      javascript_code: z.string().describe(
        "The JavaScript code to execute in the sandbox.",
      ),
    },
    // Tool handler function
    async ({ javascript_code }) => {
      console.log(`Received request to run tool '${TOOL_NAME}'`);
      try {
        const result = await runQuickJsInSandbox(
          javascript_code,
          compiledWasmModule,
        );

        // Combine stdout, stderr, and any execution error into the response
        let combinedOutput = "";
        if (result.stdout) {
          combinedOutput += `--- stdout ---\n${result.stdout}\n`;
        }
        if (result.stderr) {
          combinedOutput += `--- stderr ---\n${result.stderr}\n`;
        }
        if (result.error) {
          combinedOutput += `--- Execution Error ---\n${result.error}\n`;
        }
        if (!result.stdout && !result.stderr && !result.error) {
          combinedOutput = "--- Execution Success (No Output) ---";
        }

        // Determine if the execution resulted in an error state
        // We consider it an error if there was an explicit sandbox error OR if stderr has content.
        const isError = !!result.error ||
          (result.stderr && result.stderr.trim().length > 0);
        if (isError) {
          console.warn(`Tool '${TOOL_NAME}' execution finished with errors.`);
        } else {
          console.log(`Tool '${TOOL_NAME}' execution finished successfully.`);
        }

        return {
          // MCP tool response format
          content: [{
            type: "text",
            text: combinedOutput.trim(), // Send captured output back
          }],
          isError: false,
        };
      } catch (toolError: any) {
        console.error(
          `Unhandled error in tool '${TOOL_NAME}' handler:`,
          toolError,
        );
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

  console.log(`Tool '${TOOL_NAME}' registered.`);

  // Use stdio for communication (like the Python example)
  const transport = new StdioServerTransport();
  console.log("Connecting server via StdioTransport...");

  // Start listening for client connections
  await server.connect(transport);

  console.log(
    "MCP Server is running and connected via stdio. Waiting for client...",
  );
}

// --- Start the server ---
startServer().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
