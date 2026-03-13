/**
 * tests/skills/automatise_l_organisation_des_t_l_charge.test.js — Ghost OS v7 Unit Tests
 * Vérifie: succès, timing osascript <100ms (cache), erreur gracieuse
 */
import { execute } from "../../skills/automatise_l_organisation_des_t_l_charge/index.js";

describe("Skill: automatise_l_organisation_des_t_l_charge", () => {
  test("execute() retourne un objet avec success", async () => {
    const result = await execute({});
    expect(result).toHaveProperty("success");
    expect(typeof result.success).toBe("boolean");
  }, 10000);

  test("execute() inclut duration_ms", async () => {
    const result = await execute({});
    expect(result).toHaveProperty("duration_ms");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  }, 10000);

  test("Cache SHA-256: 2ème appel < 100ms", async () => {
    await execute({}); // warm-up cache
    const start = Date.now();
    const result = await execute({});
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result.cached).toBe(true);
  }, 5000);

  test("Paramètres invalides: retourne success:false ou gère gracieusement", async () => {
    const result = await execute({ __ghost_invalid__: true });
    expect(result).toHaveProperty("success");
  }, 10000);
});
