/**
 * test/unit/mouse_control.jest.test.js — Tests unitaires du skill mouse_control
 *
 * Couvre :
 *   - Action "move" : déplacement souris, retour { success, action, x, y, output }
 *   - Action "click" : clic gauche/droit, retour { success, action, x, y, button, output }
 *   - Action "circle" : tracé cercle, retour { success, action, x, y, radius, output }
 *   - Action inconnue : retour { success:false, error: "Action inconnue: ..." }
 *   - Gestion d'erreur : execSync lance une exception → { success:false, error }
 *
 * Stratégie : child_process est mocké via jest.unstable_mockModule — aucun
 * script Python n'est exécuté, aucune souris n'est bougée.
 */
import { jest } from "@jest/globals";

// ─── Mock child_process AVANT l'import du skill ───────────────────────────────
const mockExecSync = jest.fn();
jest.unstable_mockModule("child_process", () => ({
  execSync: mockExecSync,
}));

// ─── Import du skill après mock ───────────────────────────────────────────────
const { run } = await import("../../skills/mouse_control/skill.js");

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockExecSync.mockReset();
});

describe("mouse_control — action move", () => {
  test("retourne success:true avec les coordonnées", async () => {
    mockExecSync.mockReturnValue("Souris déplacée à (200, 300)\n");

    const result = await run({ action: "move", x: 200, y: 300 });

    expect(result.success).toBe(true);
    expect(result.action).toBe("move");
    expect(result.x).toBe(200);
    expect(result.y).toBe(300);
    expect(result.output).toBe("Souris déplacée à (200, 300)");
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  test("le script contient les coordonnées correctes", async () => {
    mockExecSync.mockReturnValue("ok");

    await run({ action: "move", x: 123, y: 456 });

    const script = mockExecSync.mock.calls[0][0];
    expect(script).toContain("123");
    expect(script).toContain("456");
    expect(script).toContain("kCGEventMouseMoved");
  });
});

describe("mouse_control — action click", () => {
  test("clic gauche : retourne success:true avec button=left", async () => {
    mockExecSync.mockReturnValue("Clic left à (100, 200)\n");

    const result = await run({ action: "click", x: 100, y: 200, button: "left" });

    expect(result.success).toBe(true);
    expect(result.action).toBe("click");
    expect(result.button).toBe("left");
    expect(result.output).toBe("Clic left à (100, 200)");
  });

  test("clic droit : retourne success:true avec button=right", async () => {
    mockExecSync.mockReturnValue("Clic right à (100, 200)\n");

    const result = await run({ action: "click", x: 100, y: 200, button: "right" });

    expect(result.success).toBe(true);
    expect(result.button).toBe("right");
  });

  test("le script clic droit contient kCGEventRightMouseDown", async () => {
    mockExecSync.mockReturnValue("ok");

    await run({ action: "click", x: 0, y: 0, button: "right" });

    const script = mockExecSync.mock.calls[0][0];
    expect(script).toContain("kCGEventRightMouseDown");
    expect(script).toContain("kCGMouseButtonRight");
  });

  test("le script clic gauche contient kCGEventLeftMouseDown", async () => {
    mockExecSync.mockReturnValue("ok");

    await run({ action: "click", x: 0, y: 0, button: "left" });

    const script = mockExecSync.mock.calls[0][0];
    expect(script).toContain("kCGEventLeftMouseDown");
    expect(script).toContain("kCGMouseButtonLeft");
  });
});

describe("mouse_control — action circle", () => {
  test("retourne success:true avec radius", async () => {
    mockExecSync.mockReturnValue("Cercle terminé\n");

    const result = await run({ action: "circle", x: 500, y: 400, radius: 150 });

    expect(result.success).toBe(true);
    expect(result.action).toBe("circle");
    expect(result.radius).toBe(150);
    expect(result.output).toBe("Cercle terminé");
  });

  test("utilise les valeurs par défaut (action=circle, x=500, y=400, r=100)", async () => {
    mockExecSync.mockReturnValue("Cercle terminé");

    const result = await run({});

    expect(result.success).toBe(true);
    expect(result.action).toBe("circle");
    expect(result.x).toBe(500);
    expect(result.y).toBe(400);
    expect(result.radius).toBe(100);
  });

  test("le script circle contient le rayon et les coords", async () => {
    mockExecSync.mockReturnValue("ok");

    await run({ action: "circle", x: 300, y: 200, radius: 75 });

    const script = mockExecSync.mock.calls[0][0];
    expect(script).toContain("300");
    expect(script).toContain("200");
    expect(script).toContain("75");
    expect(script).toContain("math.pi");
  });
});

describe("mouse_control — action inconnue", () => {
  test("retourne success:false avec message d'erreur", async () => {
    const result = await run({ action: "teleport" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Action inconnue");
    expect(result.error).toContain("teleport");
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe("mouse_control — gestion des erreurs execSync", () => {
  test("retourne success:false si execSync lance une erreur sur move", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("ImportError: No module named 'Quartz'");
    });

    const result = await run({ action: "move", x: 0, y: 0 });

    expect(result.success).toBe(false);
    expect(result.action).toBe("move");
    expect(result.error).toContain("Quartz");
  });

  test("retourne success:false si execSync lance une erreur sur click", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const result = await run({ action: "click", x: 0, y: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("permission denied");
  });

  test("retourne success:false si execSync lance une erreur sur circle", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("timeout");
    });

    const result = await run({ action: "circle" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  });
});
