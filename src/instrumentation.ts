export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv, EnvValidationError } = await import("./env");
    try {
      getEnv();
    } catch (error) {
      // Next.js logs instrumentation errors but keeps the process alive, which makes a misconfigured
      // container look healthy to its orchestrator. Exit so the failure is visible and restarts stop.
      if (error instanceof EnvValidationError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  }
}
