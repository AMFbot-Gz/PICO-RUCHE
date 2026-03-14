export async function run(params) {
  // params: { action: "move"|"click"|"circle", x, y, radius, button }
  const { action = "circle", x = 500, y = 400, radius = 100, button = "left" } = params;
  const { execSync } = await import("child_process");

  try {
    if (action === "move") {
      const script = `python3 -c "
import Quartz
event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), 0)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
print(f'Souris déplacée à (${x}, ${y})')
"`;
      const output = execSync(script, { encoding: "utf-8" }).trim();
      return { success: true, action, x, y, output };
    }

    if (action === "click") {
      const btnType = button === "right" ? "Quartz.kCGEventRightMouseDown" : "Quartz.kCGEventLeftMouseDown";
      const btnTypeUp = button === "right" ? "Quartz.kCGEventRightMouseUp" : "Quartz.kCGEventLeftMouseUp";
      const btnCode = button === "right" ? "Quartz.kCGMouseButtonRight" : "Quartz.kCGMouseButtonLeft";
      const script = `python3 -c "
import Quartz, time
pos = (${x}, ${y})
move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, pos, 0)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
time.sleep(0.05)
down = Quartz.CGEventCreateMouseEvent(None, ${btnType}, pos, ${btnCode})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
time.sleep(0.05)
up = Quartz.CGEventCreateMouseEvent(None, ${btnTypeUp}, pos, ${btnCode})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
print(f'Clic ${button} à (${x}, ${y})')
"`;
      const output = execSync(script, { encoding: "utf-8" }).trim();
      return { success: true, action, x, y, button, output };
    }

    if (action === "circle") {
      const script = `python3 -c "
import Quartz, time, math
cx, cy, r = ${x}, ${y}, ${radius}
for i in range(60):
    angle = (i / 60) * 2 * math.pi
    px = cx + int(r * math.cos(angle))
    py = cy + int(r * math.sin(angle))
    event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (px, py), 0)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    time.sleep(0.03)
print('Cercle terminé')
"`;
      const output = execSync(script, { encoding: "utf-8" }).trim();
      return { success: true, action, x, y, radius, output };
    }

    return { success: false, error: `Action inconnue: ${action}` };
  } catch (err) {
    return { success: false, action, error: err.message };
  }
}
