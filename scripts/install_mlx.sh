#!/bin/bash
echo "🍎 Installation MLX Apple Silicon..."
pip3 install mlx-lm huggingface_hub --break-system-packages 2>/dev/null || pip3 install mlx-lm huggingface_hub
echo "✅ MLX installé — pour télécharger le modèle: python3 -c \"from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Qwen3-7B-4bit', local_dir='mlx-models/qwen3-7b')\""
