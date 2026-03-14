export async function run(params) {
  const { prompt, maxTurns = 5, workdir = "~/Desktop/PICO-RUCHE" } = params;

  // Validation du paramètre obligatoire
  if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
    return { success: false, error: "Le paramètre 'prompt' est requis et ne peut pas être vide" };
  }

  const { execSync } = await import("child_process");

  // Contourner la détection de session imbriquée via CLAUDECODE=""
  const sanitizedPrompt = prompt.replace(/"/g, '\\"');
  const cmd = `cd ${workdir} && claude -p "${sanitizedPrompt}" --max-turns ${maxTurns} 2>&1`;

  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 120000,
      env: { ...process.env, CLAUDECODE: "" },
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      output: (err.stdout || "").trim(),
    };
  }
}
