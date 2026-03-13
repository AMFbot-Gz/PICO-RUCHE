"""Fixtures partagées pour tous les tests PICO-RUCHE."""
import pytest
import pytest_asyncio
import asyncio
import sys
import os

# Active le mode asyncio automatique pour tous les tests async
pytest_plugins = ['pytest_asyncio']

# Ajoute agent/ au path pour les imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'agent'))


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def mock_config():
    """Config minimale utilisée pour les tests unitaires."""
    return {
        "security": {
            "blocked_shell_patterns": [
                "rm -rf /",
                ":(){ :|:& };:",
                "dd if=/dev/zero",
                "mkfs",
                "shutdown",
                "reboot",
            ],
            "max_shell_timeout": 30,
            "require_confirmation_for": ["delete", "format", "kill", "shutdown"],
            "hitl_mode": "relay",
        },
        "ports": {
            "queen": 8001,
            "perception": 8002,
            "brain": 8003,
            "executor": 8004,
            "evolution": 8005,
            "memory": 8006,
            "mcp_bridge": 8007,
        },
        "ollama": {
            "base_url": "http://localhost:11434",
            "models": {
                "strategist": "llama3:latest",
                "worker": "llama3.2:3b",
                "vision": "moondream:latest",
                "compressor": "llama3.2:3b",
            },
            "timeout": 120,
        },
        "mlx": {
            "enabled": False,
            "server_url": "http://127.0.0.1:8080/v1",
            "fallback_to_ollama": True,
        },
        "brain": {
            "max_context_tokens": 8000,
            "compress_threshold": 6000,
            "max_subtasks": 5,
            "risk_levels": ["low", "medium", "high"],
            "auto_act_on": ["low"],
            "hitl_required_on": ["high"],
        },
        "memory": {
            "max_episodes": 500,
            "episode_file": "agent/memory/episodes.jsonl",
            "persistent_file": "agent/memory/persistent.md",
            "world_state_file": "agent/memory/world_state.json",
        },
        "perception": {
            "interval_seconds": 30,
        },
        "telegram": {
            "hitl_timeout_seconds": 120,
        },
    }
