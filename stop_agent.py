"""
Arrête proprement tous les services PICO-RUCHE
Usage: python3 stop_agent.py
"""
import subprocess
import sys

print("🛑 Arrêt PICO-RUCHE...")
ports = [8001, 8002, 8003, 8004, 8005, 8006, 8007]
for port in ports:
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True
        )
        pids = [p.strip() for p in result.stdout.strip().split("\n") if p.strip()]
        for pid in pids:
            subprocess.run(["kill", "-9", pid])
            print(f"  ✅ Port {port} libéré (PID {pid})")
        if not pids:
            print(f"  ℹ️  Port {port} déjà libre")
    except Exception as e:
        print(f"  ⚠️  Port {port}: {e}")
print("✅ PICO-RUCHE arrêté")
