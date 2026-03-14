/**
 * test/unit/invoke_claude_code.jest.test.js — Tests unitaires du skill invoke_claude_code
 *
 * Couvre :
 *   - Validation du paramètre prompt (absent, vide, non-string)
 *   - Succès : execSync retourne une sortie
 *   - Erreur : execSync lance une exception
 *   - Construction de la commande (échappement des guillemets)
 *
 * Stratégie : child_process est mocké via jest.unstable_mockModule — aucun
 * processus Claude Code n'est réellement lancé.
 */
import { jest } from "@jest/globals";

// ─── Mock child_process AVANT l'import du skill ───────────────────────────────
const mockExecSync = jest.fn();
jest.unstable_mockModule("child_process", () => ({
  execSync: mockExecSync,
}));

// ─── Import du skill après mock ───────────────────────────────────────────────
const { run } = await import("../../skills/invoke_claude_code/skill.js");

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockExecSync.mockReset();
});

describe("invoke_claude_code — validation des paramètres", () => {
  test("retourne success:false si prompt est absent", async () => {
    const result = await run({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/prompt/i);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  test("retourne success:false si prompt est une string vide", async () => {
    const result = await run({ prompt: "" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/prompt/i);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  test("retourne success:false si prompt est uniquement des espaces", async () => {
    const result = await run({ prompt: "   " });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/prompt/i);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  test("retourne success:false si prompt n'est pas une string", async () => {
    const result = await run({ prompt: 42 });
    expect(result.success).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe("invoke_claude_code — exécution réussie", () => {
  test("retourne success:true et output quand execSync réussit", async () => {
    mockExecSync.mockReturnValue("  Voici la réponse de Claude  \n");

    const result = await run({ prompt: "Analyse le projet" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Voici la réponse de Claude");
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  test("utilise maxTurns=5 par défaut", async () => {
    mockExecSync.mockReturnValue("ok");

    await run({ prompt: "test" });

    const cmd = mockExecSync.mock.calls[0][0];
    expect(cmd).toContain("--max-turns 5");
  });

  test("respecte maxTurns si fourni", async () => {
    mockExecSync.mockReturnValue("ok");

    await run({ prompt: "test", maxTurns: 10 });

    const cmd = mockExecSync.mock.calls[0][0];
    expect(cmd).toContain("--max-turns 10");
  });

  test("passe CLAUDECODE='' dans les options env", async () => {
    mockExecSync.mockReturnValue("ok");

    await run({ prompt: "test" });

    const opts = mockExecSync.mock.calls[0][1];
    expect(opts.env).toHaveProperty("CLAUDECODE", "");
  });

  test("échappe les guillemets doubles dans le prompt", async () => {
    mockExecSync.mockReturnValue("ok");

    await run({ prompt: 'Dis "bonjour"' });

    const cmd = mockExecSync.mock.calls[0][0];
    expect(cmd).toContain('\\"bonjour\\"');
  });
});

describe("invoke_claude_code — gestion des erreurs", () => {
  test("retourne success:false si execSync lance une erreur", async () => {
    const err = new Error("command not found: claude");
    mockExecSync.mockImplementation(() => {
      throw err;
    });

    const result = await run({ prompt: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("command not found");
  });

  test("inclut stdout dans output si disponible dans l'erreur", async () => {
    const err = new Error("exit code 1");
    err.stdout = "sortie partielle\n";
    mockExecSync.mockImplementation(() => {
      throw err;
    });

    const result = await run({ prompt: "test" });

    expect(result.success).toBe(false);
    expect(result.output).toBe("sortie partielle");
  });

  test("output vide si stdout absent de l'erreur", async () => {
    const err = new Error("timeout");
    mockExecSync.mockImplementation(() => {
      throw err;
    });

    const result = await run({ prompt: "test" });

    expect(result.success).toBe(false);
    expect(result.output).toBe("");
  });
});
