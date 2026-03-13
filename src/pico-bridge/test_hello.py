"""
SKILL: test_hello
DESCRIPTION: Skill de test minimal
VERSION: 1.0.0
CREATED: 2024-01-01
TRIGGER_KEYWORDS: [test, hello, bonjour, demo, exemple]
"""

def execute(params: dict) -> dict:
    try:
        message = params.get("message", "Hello PICO!")
        return {"success": True, "result": message, "error": None}
    except Exception as e:
        return {"success": False, "result": "", "error": str(e)}

if __name__ == "__main__":
    result = execute({"message": "test OK"})
    print(result)
